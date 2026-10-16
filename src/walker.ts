/**
 * The evaluator: renders a Handlebars program by walking its AST.
 *
 * Every construct is dispatched on `node.type`; nothing is compiled to
 * JavaScript, so the walker runs under the strictest Content Security
 * Policy. Behaviour follows the code Handlebars 4.7.10 would have generated
 * for the same template: the same helper-resolution order, `HelperOptions`
 * shape, partial lookup, decorator timing, and error messages.
 *
 * @packageDocumentation
 */

import { createBuiltinDecorators } from "./decorators";
import { HandlebarsRuntimeError } from "./errors";
import { escapeExpression } from "./escape";
import { createBuiltinHelpers } from "./helpers";
import { defaultLogger } from "./logger";
import { createLookupProperty } from "./lookup";
import {
  createFrame,
  createScope,
  findBlockParam,
  isScopedPath,
  pushScope,
  resolvePath,
  withoutBlockParams,
  type Scope,
} from "./scope";
import type {
  BlockRenderer,
  BlockStatement,
  DataFrame,
  DecoratorContainer,
  DecoratorDelegate,
  DecoratorMap,
  DecoratorOptions,
  Expression,
  Hash,
  HelperDelegate,
  HelperMap,
  HelperOptions,
  Literal,
  LookupProperty,
  MustacheStatement,
  Node,
  ParserProgram,
  PartialBlockStatement,
  PartialMap,
  PartialStatement,
  PathExpression,
  Program,
  RuntimeOptions,
  SourceLocation,
  Statement,
  SubExpression,
} from "./types";
import { processWhitespace } from "./whitespace";

// ---------------------------------------------------------------------------
// Options and per-render state
// ---------------------------------------------------------------------------

/** Options accepted by {@link evaluateProgram}. */
export interface EvaluateOptions extends RuntimeOptions {
  /**
   * Parses template source registered as a partial. Use
   * `parseWithoutProcessing` from `@handlebars/parser` when
   * `processWhitespace` is on (the default), so the source is not stripped
   * twice. Without a parser, string partials throw `invalid-partial`.
   */
  parse?: ((source: string) => ParserProgram) | undefined;
}

/** The `helperMissing` and `blockHelperMissing` hooks, kept apart from callable helpers as Handlebars does. */
interface Hooks {
  readonly helperMissing: HelperDelegate;
  readonly blockHelperMissing: HelperDelegate;
}

/**
 * Everything one render shares across its programs. `helpers`, `partials`,
 * and `decorators` are mutable because decorators may swap them for the
 * duration of a program; everything else is fixed for the render.
 */
interface RenderState extends DecoratorContainer {
  helpers: HelperMap;
  partials: PartialMap;
  decorators: DecoratorMap;
  readonly hooks: Hooks;
  readonly lookupProperty: LookupProperty;
  /** Stands in for `this` when the context is `null` or `undefined`, as in Handlebars. */
  readonly nullContext: object;
  readonly parse: ((source: string) => ParserProgram) | undefined;
  /** Programs parsed from string partials during this render, keyed by source. */
  readonly parsed: Map<string, ParserProgram>;
  readonly strict: boolean;
  readonly compat: boolean;
  readonly noEscape: boolean;
  readonly preventIndent: boolean;
  readonly explicitPartialContext: boolean;
  readonly knownHelpersOnly: boolean;
  readonly processWhitespace: boolean;
  readonly ignoreStandalone: boolean;
}

/**
 * Merges the built-in helpers with user helpers into a null-prototype map
 * and lifts `helperMissing` / `blockHelperMissing` out as hooks, so a
 * template cannot invoke the hooks by name.
 */
const createHelperRegistry = (
  userHelpers: HelperMap | undefined,
  logger: RuntimeOptions["logger"],
): { helpers: HelperMap; hooks: Hooks } => {
  const helpers: HelperMap = Object.assign(
    Object.create(null) as HelperMap,
    createBuiltinHelpers({ logger }),
    userHelpers,
  );
  const hooks: Hooks = {
    helperMissing: helpers.helperMissing as HelperDelegate,
    blockHelperMissing: helpers.blockHelperMissing as HelperDelegate,
  };
  delete helpers.helperMissing;
  delete helpers.blockHelperMissing;
  return { helpers, hooks };
};

/** Resolves option defaults and builds the registries for one render. */
const createRenderState = (options: EvaluateOptions): RenderState => {
  const logger = options.logger ?? defaultLogger;
  const { helpers, hooks } = createHelperRegistry(options.helpers, logger);
  return {
    helpers,
    hooks,
    partials: options.partials ?? {},
    decorators: { ...createBuiltinDecorators(), ...options.decorators },
    lookupProperty: createLookupProperty({ ...options, logger }),
    nullContext: Object.seal({}),
    parse: options.parse,
    parsed: new Map(),
    strict: options.strict === true,
    compat: options.compat === true,
    noEscape: options.noEscape === true,
    preventIndent: options.preventIndent === true,
    explicitPartialContext: options.explicitPartialContext === true,
    knownHelpersOnly: options.knownHelpersOnly === true,
    processWhitespace: options.processWhitespace !== false,
    ignoreStandalone: options.ignoreStandalone === true,
  };
};

/**
 * Builds the root `@data` frame like Handlebars' `initData`: `false`
 * disables data, `true` or nothing yields `{ root }`, and a seed object is
 * used as-is when it already has `root`, otherwise framed with `root` added.
 */
const createRootData = (context: unknown, data: boolean | DataFrame | undefined): DataFrame | undefined => {
  if (data === false) return undefined;
  if (data === true || data === undefined) return { root: context };
  return "root" in data ? data : { ...createFrame(data), root: context };
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** The `fn` / `inverse` used when a call has no block body. */
const noop: BlockRenderer = () => "";

/**
 * Converts an unescaped mustache or block result to output text; `null` and
 * `undefined` emit nothing. Uses `String()`, like {@link escapeExpression},
 * where Handlebars concatenates with `+`; the two differ only for objects
 * whose `valueOf` and `toString` disagree.
 */
const stringify = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/** Narrows to a callable so it can be invoked with an explicit `this`. */
const isFunction = (value: unknown): value is (this: unknown, ...args: unknown[]) => unknown =>
  typeof value === "function";

/** Own-property read with no prototype fallback, matching Handlebars' `lookupOwnProperty`. */
const lookupOwn = (object: unknown, name: string): unknown =>
  object !== null &&
  object !== undefined &&
  Object.prototype.hasOwnProperty.call(object, name)
    ? (object as Record<string, unknown>)[name]
    : undefined;

/**
 * The head of a call as a path. Handlebars rewrites a literal head
 * (`{{"foo"}}`, `{{#0}}`) into the path with that text, so `{{"foo"}}`
 * reads `foo`; the same rewrite is applied here. `original` is the literal
 * stringified, which also covers `undefined` and `null`.
 */
const toPath = (head: PathExpression | SubExpression | Literal): PathExpression => {
  if (head.type === "PathExpression") return head;
  const original = String("original" in head ? head.original : undefined);
  return head.loc
    ? { type: "PathExpression", data: false, depth: 0, parts: [original], original, loc: head.loc }
    : { type: "PathExpression", data: false, depth: 0, parts: [original], original };
};

/** `true` for a one-segment path with no `../`, `this`, or `./`: the only shape that can name a helper. */
const isSimpleId = (path: PathExpression): boolean =>
  path.parts.length === 1 && !isScopedPath(path) && path.depth === 0;

/** Prefixes every line of a partial's output with `indent`, except a trailing empty line. */
const indentLines = (output: string, indent: string): string => {
  const lines = output.split("\n");
  const last = lines.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i === last && lines[i] === "") break;
    lines[i] = indent + lines[i];
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * Evaluates a parameter, hash value, or sub-expression head to a raw value.
 * Functions are returned uncalled: helpers decide whether to invoke them.
 *
 * @param optional - `true` for arguments, where strict mode tolerates a missing final segment.
 */
const evaluateExpression = (
  node: Expression,
  scope: Scope,
  state: RenderState,
  optional: boolean,
): unknown => {
  switch (node.type) {
    case "PathExpression":
      return resolvePath(scope, node, {
        lookupProperty: state.lookupProperty,
        strict: state.strict,
        compat: state.compat,
        optional,
      });
    case "SubExpression":
      return evaluateCall(node, scope, state, undefined);
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
      return node.value;
    case "UndefinedLiteral":
      return undefined;
    case "NullLiteral":
      return null;
    default:
      throw unknownNode(node);
  }
};

/**
 * Evaluates `key=value` pairs into a null-prototype object. Values are
 * evaluated left to right but assigned right to left, so key order matches
 * Handlebars, whose compiler pops them off a stack (`Object.keys(hash)` of
 * `a=1 b=2` is `["b", "a"]`).
 */
const evaluateHash = (hash: Hash | undefined, scope: Scope, state: RenderState): Record<string, unknown> => {
  const result = Object.create(null) as Record<string, unknown>;
  if (hash === undefined) return result;
  const { pairs } = hash;
  const values = pairs.map((pair) => evaluateExpression(pair.value, scope, state, true));
  for (let i = pairs.length - 1; i >= 0; i--) {
    result[(pairs[i] as (typeof pairs)[number]).key] = values[i];
  }
  return result;
};

/** Evaluates positional arguments left to right. */
const evaluateParams = (params: readonly Expression[], scope: Scope, state: RenderState): unknown[] =>
  params.map((param) => evaluateExpression(param, scope, state, true));

// ---------------------------------------------------------------------------
// Calls: mustaches, blocks, and sub-expressions
// ---------------------------------------------------------------------------

/** The nodes that invoke something by name. */
type CallNode = MustacheStatement | SubExpression | BlockStatement;

/** The two bodies of a block, already bound to the scope the block appears in. */
interface BlockBodies {
  readonly fn: BlockRenderer;
  readonly inverse: BlockRenderer;
}

/**
 * How a call is dispatched, mirroring the Handlebars compiler's `classifySexpr`:
 * - `helper`: has arguments, a hash, or is a sub-expression. A helper, a context function, or `helperMissing`.
 * - `ambiguous`: a bare simple id such as `{{name}}`. A helper if one is registered, else a property.
 * - `simple`: anything else (`this.x`, `../x`, `a.b`, a block parameter). Always a property.
 */
type CallKind = "helper" | "ambiguous" | "simple";

const classify = (node: CallNode, path: PathExpression, scope: Scope, state: RenderState): CallKind => {
  const simple = isSimpleId(path);
  const name = path.parts[0] as string;
  const blockParam = simple && findBlockParam(scope, name) !== undefined;
  if (blockParam) return "simple";
  if (node.type === "SubExpression" || node.params.length > 0 || node.hash !== undefined) return "helper";
  if (!simple) return "simple";
  if (state.knownHelpersOnly && state.helpers[name] === undefined) return "simple";
  return "ambiguous";
};

/** Builds the trailing options argument every helper receives. */
const createHelperOptions = (
  name: string,
  hash: Record<string, unknown>,
  bodies: BlockBodies | undefined,
  scope: Scope,
  state: RenderState,
  loc: SourceLocation | undefined,
): HelperOptions => ({
  name,
  hash,
  data: scope.data,
  loc,
  lookupProperty: state.lookupProperty,
  fn: bodies?.fn ?? noop,
  inverse: bodies?.inverse ?? noop,
});

/** Reads the call's head from the context, in strict mode insisting the final segment exists. */
const resolveHead = (path: PathExpression, scope: Scope, state: RenderState): unknown =>
  resolvePath(scope, path, { lookupProperty: state.lookupProperty, strict: state.strict, compat: state.compat });

/**
 * `{{name arg}}`, `{{name key=value}}`, `(name ...)`: a registered helper
 * when the head is a simple id, else a function found on the context, else
 * `helperMissing`. Mirrors the compiler's `invokeHelper`.
 */
const invokeHelperCall = (
  node: CallNode,
  path: PathExpression,
  bodies: BlockBodies | undefined,
  scope: Scope,
  state: RenderState,
): unknown => {
  const name = path.parts[0] as string;
  const thisArg = scope.context ?? state.nullContext;
  const params = evaluateParams(node.params, scope, state);
  const options = createHelperOptions(path.original, evaluateHash(node.hash, scope, state), bodies, scope, state, node.loc);

  const helper = isSimpleId(path) ? state.helpers[name] : undefined;
  if (helper !== undefined) return helper.call(thisArg, ...params, options);
  if (state.knownHelpersOnly) {
    throw new HandlebarsRuntimeError(`You specified knownHelpersOnly, but used the unknown helper ${name}`, {
      code: "unknown-helper",
      loc: node.loc,
    });
  }
  const target = resolveHead(path, scope, state);
  return isFunction(target)
    ? target.call(thisArg, ...params, options)
    : state.hooks.helperMissing.call(thisArg, ...params, options);
};

/**
 * `{{name}}` or `{{#name}}`: a registered helper wins; otherwise the context
 * property is read and, if it is a function, called with the options. A
 * missing value goes to `helperMissing` (outside strict mode). For blocks
 * whose head was not a helper, the value is handed to `blockHelperMissing`.
 * Mirrors the compiler's `invokeAmbiguous` and `ambiguousBlockValue`.
 */
const invokeAmbiguousCall = (
  node: CallNode,
  path: PathExpression,
  bodies: BlockBodies | undefined,
  scope: Scope,
  state: RenderState,
): unknown => {
  const name = path.parts[0] as string;
  const thisArg = scope.context ?? state.nullContext;
  const options = createHelperOptions(name, evaluateHash(undefined, scope, state), bodies, scope, state, node.loc);

  const helper = state.helpers[name];
  if (helper !== undefined) return helper.call(thisArg, options);

  const target = resolveHead(path, scope, state);
  let value: unknown;
  if (isFunction(target)) value = target.call(thisArg, options);
  else if ((target === null || target === undefined) && !state.strict) {
    value = state.hooks.helperMissing.call(thisArg, options);
  } else value = target;

  return bodies === undefined ? value : state.hooks.blockHelperMissing.call(thisArg, value, options);
};

/**
 * `{{this.x}}`, `{{../x}}`, `{{a.b}}`, or a block parameter: a plain property
 * read. A function value is called with the context as `this`. For blocks
 * the value goes to `blockHelperMissing`. Mirrors `simpleSexpr` + `blockValue`.
 */
const invokeSimpleCall = (
  node: CallNode,
  path: PathExpression,
  bodies: BlockBodies | undefined,
  scope: Scope,
  state: RenderState,
): unknown => {
  const target = resolveHead(path, scope, state);
  const value = isFunction(target) ? target.call(scope.context) : target;
  if (bodies === undefined) return value;
  const thisArg = scope.context ?? state.nullContext;
  const options = createHelperOptions(path.original, evaluateHash(undefined, scope, state), bodies, scope, state, node.loc);
  return state.hooks.blockHelperMissing.call(thisArg, value, options);
};

/**
 * Evaluates a mustache, block, or sub-expression head to its raw value.
 *
 * @param bodies - The block bodies for a `BlockStatement`; `undefined` for inline calls.
 */
const evaluateCall = (node: CallNode, scope: Scope, state: RenderState, bodies: BlockBodies | undefined): unknown => {
  const path = toPath(node.path);
  switch (classify(node, path, scope, state)) {
    case "helper":
      return invokeHelperCall(node, path, bodies, scope, state);
    case "ambiguous":
      return invokeAmbiguousCall(node, path, bodies, scope, state);
    default:
      return invokeSimpleCall(node, path, bodies, scope, state);
  }
};

// ---------------------------------------------------------------------------
// Programs and decorators
// ---------------------------------------------------------------------------

const unknownNode = (node: Node): HandlebarsRuntimeError =>
  new HandlebarsRuntimeError(`Unknown type: ${String((node as Partial<Node>).type)}`, {
    code: "unknown-node",
    loc: (node as Partial<Node>).loc,
  });

type DecoratorStatement = Extract<Statement, { type: "Decorator" | "DecoratorBlock" }>;

const decoratorStatements = new WeakMap<Program, readonly DecoratorStatement[]>();

/** The decorators declared directly in `program`, found once and cached so hot loops do not rescan the body. */
const findDecorators = (program: Program): readonly DecoratorStatement[] => {
  let found = decoratorStatements.get(program);
  if (found === undefined) {
    found = program.body.filter(
      (statement): statement is DecoratorStatement =>
        statement.type === "Decorator" || statement.type === "DecoratorBlock",
    );
    decoratorStatements.set(program, found);
  }
  return found;
};

/**
 * Runs the decorators declared directly in `program` and returns the
 * renderer they produce. Decorators run when the renderer is created, not
 * when it is called, so an inline partial is visible to the whole program
 * even when the call precedes the declaration, and a decorator inside a
 * block runs even if the block body never renders, exactly as in Handlebars.
 *
 * Arguments are evaluated in `scope`, the scope the program is declared in.
 * All decorators on one program share a `props` object, which is copied
 * onto the final renderer (that is how `inline` exposes `fn.partials`).
 *
 * @throws {@link HandlebarsRuntimeError} with code `missing-decorator` for an unregistered name.
 */
const applyDecorators = (program: Program, renderer: BlockRenderer, scope: Scope, state: RenderState): BlockRenderer => {
  const statements = findDecorators(program);
  if (statements.length === 0) return renderer;

  let fn = renderer;
  const props: Record<string, unknown> = {};
  for (const statement of statements) {
    const name = toPath(statement.path).original;
    const decorator = state.lookupProperty(state.decorators, name);
    if (typeof decorator !== "function") {
      throw new HandlebarsRuntimeError(`Missing decorator: "${name}"`, { code: "missing-decorator", loc: statement.loc });
    }
    const options: DecoratorOptions = {
      name,
      args: evaluateParams(statement.params, scope, state),
      hash: evaluateHash(statement.hash, scope, state),
      fn: statement.type === "DecoratorBlock" ? createProgramRenderer(statement.program, scope, state) : undefined,
      data: scope.data,
      loc: statement.loc,
    };
    fn = (decorator as DecoratorDelegate)(fn, props, state, options) ?? fn;
  }
  Object.assign(fn, props);
  return fn;
};

/**
 * Creates the `fn` / `inverse` renderer for a block body. Calling it pushes
 * one scope frame with the given context, the given data frame (or the
 * frame in effect where the block appears), and the block's `as |a b|`
 * names bound to `options.blockParams`. Decorators declared in the body are
 * applied immediately.
 *
 * @returns A {@link BlockRenderer}; `noop` when the body is absent.
 */
const createProgramRenderer = (program: Program | undefined, scope: Scope, state: RenderState): BlockRenderer => {
  if (program === undefined) return noop;
  const names = program.blockParams;
  const renderer: BlockRenderer = (context, options) =>
    renderProgram(
      program,
      pushScope(scope, {
        context,
        data: options?.data ?? scope.data,
        blockParams: names === undefined ? undefined : { names, values: options?.blockParams ?? [] },
      }),
      state,
    );
  return applyDecorators(program, renderer, scope, state);
};

/**
 * Renders a template's root program (the top level or a partial) in an
 * already-created scope. Root decorators see the root context, which is
 * more useful than the `undefined` Handlebars passes them there.
 */
const renderRoot = (program: Program, scope: Scope, state: RenderState): string =>
  applyDecorators(program, () => renderProgram(program, scope, state), scope, state)(scope.context);

/** Renders a program body statement by statement. */
const renderProgram = (program: Program, scope: Scope, state: RenderState): string => {
  let output = "";
  for (const statement of program.body) output += renderStatement(statement, scope, state);
  return output;
};

/** Renders one statement. Decorators render nothing here; they ran when the program's renderer was created. */
const renderStatement = (node: Statement, scope: Scope, state: RenderState): string => {
  switch (node.type) {
    case "ContentStatement":
      return node.value;
    case "CommentStatement":
    case "Decorator":
    case "DecoratorBlock":
      return "";
    case "MustacheStatement": {
      const value = evaluateCall(node, scope, state, undefined);
      return node.escaped && !state.noEscape ? escapeExpression(value) : stringify(value);
    }
    case "BlockStatement":
      return stringify(
        evaluateCall(node, scope, state, {
          fn: createProgramRenderer(node.program, scope, state),
          inverse: createProgramRenderer(node.inverse, scope, state),
        }),
      );
    case "PartialStatement":
    case "PartialBlockStatement":
      return renderPartial(node, scope, state);
    default:
      throw unknownNode(node);
  }
};

// ---------------------------------------------------------------------------
// Partials
// ---------------------------------------------------------------------------

type PartialNode = PartialStatement | PartialBlockStatement;

/**
 * The context a partial renders with: the single argument if written, else
 * the current context (or `undefined` under `explicitPartialContext`), then
 * shallow-merged with the hash when one was written.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` for more than one argument.
 */
const resolvePartialContext = (node: PartialNode, scope: Scope, state: RenderState): unknown => {
  if (node.params.length > 1) {
    throw new HandlebarsRuntimeError(`Unsupported number of partial arguments: ${node.params.length}`, {
      code: "invalid-arguments",
      loc: node.loc,
    });
  }
  const [param] = node.params;
  const context =
    param !== undefined
      ? evaluateExpression(param, scope, state, true)
      : state.explicitPartialContext
        ? undefined
        : scope.context;
  return node.hash === undefined ? context : Object.assign({}, context, evaluateHash(node.hash, scope, state));
};

/**
 * Finds the partial a node refers to, following Handlebars' `resolvePartial`:
 * a static name is looked up in the partials in effect, with `@partial-block`
 * falling back to the data frame; a dynamic name (sub-expression) that
 * yields a function is the partial itself, and any other value is used as
 * the name.
 */
const resolvePartialTemplate = (
  node: PartialNode,
  scope: Scope,
  state: RenderState,
): { name: unknown; partial: unknown } => {
  if (node.name.type === "SubExpression") {
    const value = evaluateExpression(node.name, scope, state, true);
    if (isFunction(value)) return { name: undefined, partial: value };
    return { name: value, partial: lookupOwn(state.partials, String(value)) };
  }
  const name = toPath(node.name).original;
  let partial = state.lookupProperty(state.partials, name);
  if (partial === undefined && name === "@partial-block") partial = lookupOwn(scope.data, "partial-block");
  return { name, partial };
};

/**
 * Parses partial source through the environment's `parse`, once per
 * distinct source string per render, so a partial invoked inside `#each`
 * is not re-parsed on every iteration.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-partial` when no parser was provided.
 */
const parsePartialSource = (source: string, name: unknown, state: RenderState, loc: SourceLocation | undefined): ParserProgram => {
  const cached = state.parsed.get(source);
  if (cached !== undefined) return cached;
  if (state.parse === undefined) {
    throw new HandlebarsRuntimeError(
      `The partial ${String(name)} could not be compiled: no parse function was provided for string partials`,
      { code: "invalid-partial", loc },
    );
  }
  const program = state.parse(source);
  state.parsed.set(source, program);
  return program;
};

/**
 * Turns a registered partial into a program, parsing source when needed and
 * applying whitespace control when enabled.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-partial` for source without a parser or an unrecognised value.
 */
const toPartialProgram = (partial: unknown, name: unknown, state: RenderState, loc: SourceLocation | undefined): Program => {
  let program: ParserProgram | undefined;
  if (typeof partial === "string") {
    program = parsePartialSource(partial, name, state, loc);
  } else if (partial !== null && typeof partial === "object" && (partial as Partial<Node>).type === "Program") {
    program = partial as ParserProgram;
  }
  if (program === undefined) {
    throw new HandlebarsRuntimeError(
      `The partial ${String(name)} could not be compiled: partials must be strings, programs, or functions`,
      { code: "invalid-partial", loc },
    );
  }
  if (state.processWhitespace) processWhitespace(program, { ignoreStandalone: state.ignoreStandalone });
  return program as unknown as Program;
};

/**
 * Prepares `@partial-block` for `{{#> name}}body{{/name}}`: a child data
 * frame whose `partial-block` renders the body, and the body's own inline
 * partials (if any) merged into the partials the partial will see.
 *
 * The body renderer re-frames the data it is called with and restores the
 * enclosing `@partial-block`, so nested partial blocks resolve outward.
 */
const preparePartialBlock = (
  program: Program,
  scope: Scope,
  state: RenderState,
): { partialBlock: BlockRenderer; data: DataFrame | undefined; partials: PartialMap } => {
  const body = createProgramRenderer(program, scope, state);
  const enclosing = lookupOwn(scope.data, "partial-block");
  const partialBlock: BlockRenderer = (context, options) =>
    body(context, { ...options, data: Object.assign(createFrame(options?.data), { "partial-block": enclosing }) });

  let data = scope.data;
  if (data !== undefined) {
    data = createFrame(data);
    data["partial-block"] = partialBlock;
  }
  const declared = (body as BlockRenderer & { partials?: PartialMap }).partials;
  return { partialBlock, data, partials: declared === undefined ? state.partials : { ...state.partials, ...declared } };
};

/**
 * Renders `{{> name}}` or `{{#> name}}...{{/name}}`.
 *
 * A partial renders in a fresh context chain, so `../` inside it reads
 * nothing unless `compat` is set, in which case the caller's chain is kept.
 * Block parameters never cross into a partial. A missing partial renders the
 * `{{#> }}` body when there is one and throws otherwise. Standalone partial
 * lines re-indent every output line, unless `preventIndent` is set.
 *
 * @throws {@link HandlebarsRuntimeError} with code `missing-partial` when nothing resolves.
 */
const renderPartial = (node: PartialNode, scope: Scope, state: RenderState): string => {
  const context = resolvePartialContext(node, scope, state);
  const resolved = resolvePartialTemplate(node, scope, state);

  let { partial } = resolved;
  let data = scope.data;
  let partials = state.partials;
  if (node.type === "PartialBlockStatement") {
    const prepared = preparePartialBlock(node.program, scope, state);
    ({ data, partials } = prepared);
    partial ??= prepared.partialBlock;
  }
  if (partial === undefined) {
    throw new HandlebarsRuntimeError(`The partial ${String(resolved.name)} could not be found`, {
      code: "missing-partial",
      loc: node.loc,
    });
  }

  const previousPartials = state.partials;
  state.partials = partials;
  let output: string;
  try {
    if (isFunction(partial)) {
      output = stringify(partial.call(undefined, context, { data }));
    } else {
      const program = toPartialProgram(partial, resolved.name, state, node.loc);
      const partialScope = state.compat
        ? pushScope(withoutBlockParams(scope), { context, data })
        : createScope({ context, data });
      output = renderRoot(program, partialScope, state);
    }
  } finally {
    state.partials = previousPartials;
  }

  const indent = node.type === "PartialStatement" ? node.indent : "";
  if (!indent) return output;
  return state.preventIndent ? indent + output : indentLines(output, indent);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Renders a parsed Handlebars program.
 *
 * The program should come from `parseWithoutProcessing`; whitespace control
 * is applied in place on first use unless `processWhitespace` is `false`.
 * Built-in helpers and the `inline` decorator are always available; options
 * supply additional helpers, partials, decorators, and runtime flags.
 *
 * @param program - The root program to render.
 * @param context - The root context (`this` at the top level).
 * @param options - Registries and runtime flags for this render.
 * @returns The rendered output.
 *
 * @example
 * ```ts
 * import { parseWithoutProcessing } from "@handlebars/parser";
 *
 * evaluateProgram(parseWithoutProcessing("Hi {{name}}!"), { name: "Ada" });
 * // "Hi Ada!"
 * ```
 */
export const evaluateProgram = (program: ParserProgram, context?: unknown, options: EvaluateOptions = {}): string => {
  const state = createRenderState(options);
  if (state.processWhitespace) processWhitespace(program, { ignoreStandalone: state.ignoreStandalone });
  const scope = createScope({ context, data: createRootData(context, options.data) });
  return renderRoot(program as unknown as Program, scope, state);
};
