/**
 * Type contracts for the Handlebars AST walker.
 *
 * The AST interfaces mirror what `@handlebars/parser` produces at runtime
 * (which is slightly looser than its published `.d.ts`): properties the
 * parser omits, such as `hash`, `inverse`, or `program`, are optional here.
 * Source locations are optional so hand-built ASTs type-check without them.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Source locations
// ---------------------------------------------------------------------------

/** A line/column pair. Lines are 1-based, columns are 0-based. */
export interface Position {
  line: number;
  column: number;
}

/** Span of a node in the template source. `source` is the `srcName` parse option when given. */
export interface SourceLocation {
  source?: string;
  start: Position;
  end: Position;
}

/** Common shape of every AST node. */
export interface Node {
  type: string;
  loc?: SourceLocation;
}

/**
 * Whitespace-control flags recorded from `~` on an opening (`{{~`) or
 * closing (`~}}`) delimiter.
 */
export interface StripFlags {
  open: boolean;
  close: boolean;
}

// ---------------------------------------------------------------------------
// Programs and statements
// ---------------------------------------------------------------------------

/**
 * A sequence of statements. The root of a template and the body of every
 * block, inverse, partial block, and decorator block.
 */
export interface Program extends Node {
  type: "Program";
  body: Statement[];
  /** Names declared with `as |a b|` on the enclosing block. */
  blockParams?: string[];
  /** Set on an inverse program produced by `{{else if ...}}` chaining. */
  chained?: boolean;
}

/**
 * Loose structural shape of `@handlebars/parser`'s `AST.Program`.
 *
 * The parser's declarations type every node as `{ type: string }`, so its
 * output cannot be assigned to the strict {@link Program} union directly.
 * Public entry points accept this shape and validate nodes by `type` while
 * walking, so parser output can be passed without a cast.
 */
export interface ParserProgram {
  type: string;
  loc?: SourceLocation;
  body: ReadonlyArray<{ type: string }>;
  blockParams?: string[];
  chained?: boolean;
}

/** Literal template text between tags. */
export interface ContentStatement extends Node {
  type: "ContentStatement";
  /** Text as it will be emitted; whitespace control edits this in place. */
  value: string;
  /** Text exactly as written in the template. Never mutated. */
  original: string;
  /** Set by whitespace control once leading whitespace has been removed. */
  leftStripped?: boolean;
  /** Set by whitespace control once trailing whitespace has been removed. */
  rightStripped?: boolean;
}

/** `{{! comment }}` or `{{!-- comment --}}`. Produces no output. */
export interface CommentStatement extends Node {
  type: "CommentStatement";
  value: string;
  strip: StripFlags;
}

/** `{{expr}}`, `{{{expr}}}`, or `{{& expr}}`. */
export interface MustacheStatement extends Node {
  type: "MustacheStatement";
  /** A literal here (`{{"foo"}}`) is treated as the path `foo`, like Handlebars does. */
  path: PathExpression | SubExpression | Literal;
  params: Expression[];
  hash?: Hash;
  /** `false` for `{{{ }}}` and `{{& }}`. */
  escaped: boolean;
  strip: StripFlags;
}

/** `{{* decorator}}`. Same shape as a mustache, applied to the enclosing program. */
export interface Decorator extends Omit<MustacheStatement, "type"> {
  type: "Decorator";
}

/**
 * `{{#name}}...{{else}}...{{/name}}` or `{{^name}}...{{/name}}`.
 *
 * `program` is absent for inverse-only blocks (`{{^name}}`), `inverse` is
 * absent when there is no `{{else}}`, and `inverseStrip` is present only
 * when an `{{else}}` tag was written.
 */
export interface BlockStatement extends Node {
  type: "BlockStatement";
  path: PathExpression | SubExpression | Literal;
  params: Expression[];
  hash?: Hash;
  program?: Program;
  inverse?: Program;
  openStrip: StripFlags;
  inverseStrip?: StripFlags;
  closeStrip: StripFlags;
}

/** `{{#* decorator}}...{{/decorator}}`, e.g. `{{#*inline "name"}}`. */
export interface DecoratorBlock extends Omit<BlockStatement, "type"> {
  type: "DecoratorBlock";
}

/** `{{> name context key=value}}`. */
export interface PartialStatement extends Node {
  type: "PartialStatement";
  /** A `SubExpression` for dynamic partials; a `Literal` for `{{> "name"}}`. */
  name: PathExpression | SubExpression | Literal;
  params: Expression[];
  hash?: Hash;
  /** Leading whitespace of a standalone partial line, re-applied to each rendered line. */
  indent: string;
  strip: StripFlags;
}

/** `{{#> name}}fallback{{/name}}`. The body becomes `@partial-block`. */
export interface PartialBlockStatement extends Node {
  type: "PartialBlockStatement";
  name: PathExpression | SubExpression | Literal;
  params: Expression[];
  hash?: Hash;
  program: Program;
  openStrip: StripFlags;
  closeStrip: StripFlags;
}

/** Every node that can appear in a {@link Program} body. */
export type Statement =
  | ContentStatement
  | CommentStatement
  | MustacheStatement
  | Decorator
  | BlockStatement
  | DecoratorBlock
  | PartialStatement
  | PartialBlockStatement;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** `(helper arg key=value)` nested inside another expression. */
export interface SubExpression extends Node {
  type: "SubExpression";
  path: PathExpression | SubExpression | Literal;
  params: Expression[];
  hash?: Hash;
}

/**
 * A reference such as `name`, `a.b`, `../x`, `this`, `./y`, `@index`, or
 * `[literal segment]`.
 *
 * `depth` counts leading `../` segments. `parts` holds the dotted segments
 * with `this`, `.`, and `..` removed; it is empty for a bare `this` or `.`.
 */
export interface PathExpression extends Node {
  type: "PathExpression";
  /** `true` for `@data` paths such as `@index` or `@root.x`. */
  data: boolean;
  depth: number;
  parts: string[];
  original: string;
  /** `true` when the path was written with an explicit `this.` prefix. */
  this?: boolean;
  /** First segment of `parts`; absent for a bare `this` or `.`. */
  head?: string;
  /** Segments after `head`. */
  tail?: string[];
}

/** `"text"` or `'text'`. */
export interface StringLiteral extends Node {
  type: "StringLiteral";
  value: string;
  original: string;
}

/** An integer or decimal number. */
export interface NumberLiteral extends Node {
  type: "NumberLiteral";
  value: number;
  original: number;
}

/** `true` or `false`. */
export interface BooleanLiteral extends Node {
  type: "BooleanLiteral";
  value: boolean;
  original: boolean;
}

/** The keyword `undefined`. */
export interface UndefinedLiteral extends Node {
  type: "UndefinedLiteral";
}

/** The keyword `null`. */
export interface NullLiteral extends Node {
  type: "NullLiteral";
  value?: null;
  original?: null;
}

/** Every literal expression. */
export type Literal =
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | UndefinedLiteral
  | NullLiteral;

/** Every node that can appear as a parameter or hash value. */
export type Expression = PathExpression | SubExpression | Literal;

/** The `key=value ...` arguments of a mustache, block, partial, or sub-expression. */
export interface Hash extends Node {
  type: "Hash";
  pairs: HashPair[];
}

/** One `key=value` argument. */
export interface HashPair extends Node {
  type: "HashPair";
  key: string;
  value: Expression;
}

/** Every AST node type produced by the parser. */
export type AnyNode = Program | Statement | Expression | Hash | HashPair;

// ---------------------------------------------------------------------------
// Runtime contracts
// ---------------------------------------------------------------------------

/**
 * The `@data` frame visible to a template. Frames are created per block by
 * shallow-copying the parent and linking it through `_parent`, exactly like
 * `Handlebars.createFrame`.
 *
 * Well-known keys are declared for discoverability; helpers may add any key.
 */
export interface DataFrame {
  /** The frame this one was created from. */
  _parent?: DataFrame;
  /** The context the template was rendered with (`@root`). */
  root?: unknown;
  /** Set by `#each` for arrays and iterables. */
  index?: number;
  /** Set by `#each` for every iteration; the array index or object key. */
  key?: number | string;
  first?: boolean;
  last?: boolean;
  /** Set when rendering a partial block; the fallback body of `{{#> name}}`. */
  "partial-block"?: BlockRenderer;
  [name: string]: unknown;
}

/** Per-invocation options for a helper's `fn` and `inverse` callbacks. */
export interface BlockOptions {
  /** Data frame for the block body; defaults to the frame the helper received. */
  data?: DataFrame;
  /** Values bound, in order, to the block's `as |a b|` parameters. */
  blockParams?: unknown[];
}

/**
 * Renders a block body (`options.fn`) or its inverse (`options.inverse`).
 *
 * @param context - Becomes `this` inside the block. Omit to render with an undefined context.
 * @param options - Data frame and block parameter values for the body.
 * @returns The rendered block as a string.
 */
export interface BlockRenderer {
  (context?: unknown, options?: BlockOptions): string;
}

/**
 * Secure property access as exposed to helpers. Follows the Handlebars
 * prototype-access rules configured through {@link RuntimeOptions}.
 *
 * @param parent - The object to read from. Non-objects yield `undefined`.
 * @param propertyName - The property to read.
 */
export interface LookupProperty {
  (parent: unknown, propertyName: string): unknown;
}

/**
 * The final argument passed to every helper.
 *
 * @example
 * ```ts
 * const bold: HelperDelegate = (text: string, options: HelperOptions) =>
 *   new SafeString(`<b>${escapeExpression(text)}</b>`);
 * ```
 */
export interface HelperOptions {
  /** The helper name as written in the template. */
  name: string;
  /** Evaluated `key=value` arguments. An object with a `null` prototype. */
  hash: Record<string, unknown>;
  /** Current `@data` frame, or `undefined` when data tracking is disabled. */
  data?: DataFrame;
  /** Location of the invoking expression when the AST carries locations. */
  loc?: SourceLocation;
  lookupProperty: LookupProperty;
  /** Renders the block body. A no-op returning `""` for non-block invocations. */
  fn: BlockRenderer;
  /** Renders the `{{else}}` body. A no-op returning `""` when absent. */
  inverse: BlockRenderer;
}

/**
 * A helper function. Positional arguments arrive first, then a single
 * {@link HelperOptions}. `this` is the current template context.
 *
 * Declared through a method signature so helpers written with narrower
 * parameter types, such as `(name: string, options: HelperOptions) => string`,
 * remain assignable without casts.
 */
export type HelperDelegate = {
  bivarianceHack(this: unknown, ...args: unknown[]): unknown;
}["bivarianceHack"];

/** A registry of helpers keyed by name. */
export type HelperMap = Record<string, HelperDelegate>;

/**
 * A registered partial: a parsed program or, when the environment has a
 * `parse` function, raw template source.
 */
export type PartialTemplate = ParserProgram | string;

/** A registry of partials keyed by name. */
export type PartialMap = Record<string, PartialTemplate>;

/** Options passed to a decorator, mirroring Handlebars' decorator contract. */
export interface DecoratorOptions {
  name: string;
  /** Evaluated positional arguments. */
  args: unknown[];
  hash: Record<string, unknown>;
  /** The decorator block body, when written as `{{#*name}}...{{/name}}`. */
  fn?: BlockRenderer;
  data?: DataFrame;
  loc?: SourceLocation;
}

/** Mutable registries a decorator may read or replace for the rest of a render. */
export interface DecoratorContainer {
  helpers: HelperMap;
  partials: PartialMap;
  decorators: DecoratorMap;
}

/**
 * A decorator wraps the rendering of the program it appears in.
 *
 * @param program - Renders the decorated program.
 * @param props - Shared across every decorator applied to the same program.
 * @param container - Registries in effect for the current render.
 * @param options - Arguments and hash of the decorator call.
 * @returns A replacement renderer, or `undefined` to keep `program`.
 */
export type DecoratorDelegate = (
  program: BlockRenderer,
  props: Record<string, unknown>,
  container: DecoratorContainer,
  options: DecoratorOptions,
) => BlockRenderer | undefined;

/** A registry of decorators keyed by name. */
export type DecoratorMap = Record<string, DecoratorDelegate>;

/**
 * Receives `{{log}}` output and access-control warnings.
 *
 * Levels follow Handlebars: `0`/`"debug"`, `1`/`"info"`, `2`/`"warn"`, `3`/`"error"`.
 */
export interface Logger {
  /** Minimum level that is emitted. */
  level: number | string;
  log(level: number | string, ...message: unknown[]): void;
}

/**
 * Options accepted by `createEnvironment`, `compileAST`, and every render.
 * Render-time values override environment defaults for that render only.
 */
export interface RuntimeOptions {
  /** Extra helpers for this render. Take precedence over environment helpers. */
  helpers?: HelperMap;
  /** Extra partials for this render. Take precedence over environment partials. */
  partials?: PartialMap;
  /** Extra decorators for this render. */
  decorators?: DecoratorMap;
  /**
   * `false` disables `@data` variables. An object seeds the root data frame
   * (`@root` is still set automatically). Defaults to `true`.
   */
  data?: boolean | DataFrame;
  /** Allow reading inherited (prototype) non-function properties. Default `false`. */
  allowProtoPropertiesByDefault?: boolean;
  /** Allow calling inherited (prototype) methods. Default `false`. */
  allowProtoMethodsByDefault?: boolean;
  /** Per-name overrides for inherited property access. */
  allowedProtoProperties?: Record<string, boolean>;
  /** Per-name overrides for inherited method access. */
  allowedProtoMethods?: Record<string, boolean>;
  /** Throw when a path resolves through a missing property. Default `false`. */
  strict?: boolean;
  /** Fall back to parent contexts when a lookup misses (Mustache compatibility). Default `false`. */
  compat?: boolean;
  /** Skip HTML escaping for every `{{expr}}`. Default `false`. */
  noEscape?: boolean;
  /** Do not re-indent partial output on standalone partial lines. Default `false`. */
  preventIndent?: boolean;
  /** Render partials with an undefined context unless one is passed explicitly. Default `false`. */
  explicitPartialContext?: boolean;
  /** Throw on helper-shaped calls to names that are not registered helpers. Default `false`. */
  knownHelpersOnly?: boolean;
  /**
   * Run the whitespace-control pass on the AST before rendering. Set `false`
   * for ASTs produced by `Handlebars.parse` or `@handlebars/parser`'s `parse`,
   * which are already processed. Defaults to `true`.
   */
  processWhitespace?: boolean;
  /** Keep standalone block and comment lines instead of removing them. Default `false`. */
  ignoreStandalone?: boolean;
  logger?: Logger;
}

/**
 * A compiled template.
 *
 * @typeParam TContext - Shape of the root context.
 * @param context - The root context (`this` at the top level).
 * @param options - Render-time overrides of {@link RuntimeOptions}.
 * @returns The rendered output.
 */
export interface TemplateDelegate<TContext = unknown> {
  (context?: TContext, options?: RuntimeOptions): string;
}
