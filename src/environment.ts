/**
 * Environments, template compilation, and one-shot rendering: the public
 * surface that `src/index.ts` exports.
 *
 * An environment is the walker's counterpart to `Handlebars.create()`: a
 * mutable set of helpers, partials, and decorators plus default runtime
 * options and a logger. Templates compiled against an environment read its
 * registries at render time, so registering a helper after `compileAST` is
 * still visible to the compiled template, exactly as in Handlebars.
 *
 * @packageDocumentation
 */

import { HandlebarsRuntimeError } from "./errors";
import { createLogger } from "./logger";
import type {
  DecoratorDelegate,
  DecoratorMap,
  HelperDelegate,
  HelperMap,
  Logger,
  ParserProgram,
  PartialMap,
  PartialTemplate,
  RuntimeOptions,
  TemplateDelegate,
} from "./types";
import { evaluateProgram, type EvaluateOptions } from "./walker";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** Parses Handlebars source into an unprocessed program, e.g. `parseWithoutProcessing` from `@handlebars/parser`. */
export type ParseFunction = (source: string) => ParserProgram;

/**
 * Options accepted by {@link createEnvironment} and {@link renderAST}.
 *
 * `helpers`, `partials`, and `decorators` seed the environment's registries;
 * every other {@link RuntimeOptions} field becomes the default for renders
 * through that environment.
 */
export interface EnvironmentOptions extends RuntimeOptions {
  /**
   * Parses template source registered as a partial. Use
   * `parseWithoutProcessing` from `@handlebars/parser` so string partials
   * are not whitespace-stripped twice. Without it, string partials throw
   * `invalid-partial` when rendered.
   */
  parse?: ParseFunction | undefined;
}

/**
 * A registry of helpers, partials, and decorators with default runtime
 * options, shared by every template compiled against it.
 *
 * Registries are plain objects with a `null` prototype, exposed for
 * inspection; use the `register*` / `unregister*` methods to change them.
 */
export interface Environment {
  /** Helpers available to every render. Does not include the built-ins, which are always present. */
  readonly helpers: HelperMap;
  readonly partials: PartialMap;
  /** Decorators available to every render, in addition to the built-in `inline`. */
  readonly decorators: DecoratorMap;
  /** Default runtime options for every render; render-time options override them. */
  readonly options: Readonly<RuntimeOptions>;
  /** Receives `{{log}}` output and access-control warnings. `level` is mutable, like `Handlebars.logger.level`. */
  readonly logger: Logger;
  /** The parser used for string partials, when one was given. */
  readonly parse: ParseFunction | undefined;

  /**
   * Registers one helper by name, or every entry of a map.
   *
   * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` when the helper is missing or a map is given with a second argument.
   */
  registerHelper(name: string, helper: HelperDelegate): void;
  registerHelper(helpers: HelperMap): void;
  unregisterHelper(name: string): void;

  /**
   * Registers one partial by name, or every entry of a map. A partial is a
   * program, template source (requires `parse`), or a function.
   *
   * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` when the partial is missing or a map is given with a second argument.
   */
  registerPartial(name: string, partial: PartialTemplate): void;
  registerPartial(partials: PartialMap): void;
  unregisterPartial(name: string): void;

  /**
   * Registers one decorator by name, or every entry of a map.
   *
   * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` when the decorator is missing or a map is given with a second argument.
   */
  registerDecorator(name: string, decorator: DecoratorDelegate): void;
  registerDecorator(decorators: DecoratorMap): void;
  unregisterDecorator(name: string): void;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** Copies `initial` onto a fresh `null`-prototype object so `{{constructor}}` cannot reach `Object.prototype`. */
const createRegistry = <T>(initial: Record<string, T> | undefined): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, initial);

/**
 * Shared body of the `register*` methods, following Handlebars' argument
 * rules: `(name, value)` sets one entry, `(map)` merges many, and mixing
 * the two shapes or omitting the value is an error.
 */
const register = <T>(
  registry: Record<string, T>,
  kind: string,
  nameOrMap: string | Record<string, T>,
  value: T | undefined,
): void => {
  if (typeof nameOrMap === "string") {
    if (value === undefined) {
      throw new HandlebarsRuntimeError(`Attempting to register a ${kind} called "${nameOrMap}" as undefined`, {
        code: "invalid-arguments",
      });
    }
    registry[nameOrMap] = value;
    return;
  }
  if (value !== undefined) {
    throw new HandlebarsRuntimeError(`Arg not supported with multiple ${kind}s`, { code: "invalid-arguments" });
  }
  Object.assign(registry, nameOrMap);
};

/**
 * Creates an environment: the walker's equivalent of `Handlebars.create()`.
 *
 * @param options - Initial registries, default runtime options, a logger, and an optional parser for string partials.
 * @returns A new, independent {@link Environment}.
 *
 * @example
 * ```ts
 * import { parseWithoutProcessing } from "@handlebars/parser";
 *
 * const env = createEnvironment({ parse: parseWithoutProcessing });
 * env.registerHelper("upper", (text: unknown) => String(text).toUpperCase());
 * env.registerPartial("row", "<li>{{upper this}}</li>");
 *
 * const template = compileAST(parseWithoutProcessing("{{#each items}}{{> row}}{{/each}}"), env);
 * template({ items: ["a", "b"] }); // "<li>A</li><li>B</li>"
 * ```
 */
export const createEnvironment = (options: EnvironmentOptions = {}): Environment => {
  const { helpers, partials, decorators, logger, parse, ...defaults } = options;
  const helperRegistry = createRegistry(helpers);
  const partialRegistry = createRegistry(partials);
  const decoratorRegistry = createRegistry(decorators);

  return {
    helpers: helperRegistry,
    partials: partialRegistry,
    decorators: decoratorRegistry,
    options: Object.freeze(defaults),
    logger: logger ?? createLogger(),
    parse,

    registerHelper(nameOrMap: string | HelperMap, helper?: HelperDelegate): void {
      register(helperRegistry, "helper", nameOrMap, helper);
    },
    unregisterHelper(name: string): void {
      delete helperRegistry[name];
    },

    registerPartial(nameOrMap: string | PartialMap, partial?: PartialTemplate): void {
      register(partialRegistry, "partial", nameOrMap, partial);
    },
    unregisterPartial(name: string): void {
      delete partialRegistry[name];
    },

    registerDecorator(nameOrMap: string | DecoratorMap, decorator?: DecoratorDelegate): void {
      register(decoratorRegistry, "decorator", nameOrMap, decorator);
    },
    unregisterDecorator(name: string): void {
      delete decoratorRegistry[name];
    },
  };
};

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Layers one entry of render-time registry over the environment's. The
 * environment registry is returned as-is when the render adds nothing, so
 * the common case does not copy.
 */
const layer = <T>(base: Record<string, T>, extra: Record<string, T> | undefined): Record<string, T> =>
  extra === undefined ? base : { ...base, ...extra };

/**
 * Resolves the options for one render: render-time flags over environment
 * defaults, render-time registries over environment registries, and the
 * render-time logger over the environment's.
 */
const resolveOptions = (environment: Environment, options: RuntimeOptions): EvaluateOptions => {
  const resolved: EvaluateOptions = {
    ...environment.options,
    ...options,
    helpers: layer(environment.helpers, options.helpers),
    partials: layer(environment.partials, options.partials),
    decorators: layer(environment.decorators, options.decorators),
    logger: options.logger ?? environment.logger,
  };
  if (environment.parse !== undefined) resolved.parse = environment.parse;
  return resolved;
};

/** Describes a non-program value for the `invalid-program` message. */
const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : "an object without a type";
};

/**
 * Checks that `program` is a `Program` node before anything else is done
 * with it, so a parse-time mistake fails with a clear message rather than
 * deep inside the walker.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-program`.
 */
const assertProgram: (program: unknown) => asserts program is ParserProgram = (program) => {
  const isProgram =
    program !== null &&
    typeof program === "object" &&
    (program as Partial<ParserProgram>).type === "Program" &&
    Array.isArray((program as Partial<ParserProgram>).body);
  if (!isProgram) {
    throw new HandlebarsRuntimeError(
      `Expected a Program node from parseWithoutProcessing, received ${describeValue(program)}`,
      { code: "invalid-program" },
    );
  }
};

/**
 * Compiles an unprocessed program into a reusable render function.
 *
 * Nothing is generated: the returned delegate walks the AST on every call.
 * Whitespace control is applied in place on the first render (unless
 * `processWhitespace` is `false`) and never repeated. Registries are read
 * from the environment at render time, so helpers and partials registered
 * after compilation are still available.
 *
 * @typeParam TContext - Shape of the root context.
 * @param program - A `Program` from `parseWithoutProcessing`.
 * @param environment - Registries and defaults to render with. Without one, only the built-in helpers and render-time options apply.
 * @returns A {@link TemplateDelegate}; render-time options override the environment defaults for that call only.
 * @throws {@link HandlebarsRuntimeError} with code `invalid-program` when `program` is not a `Program` node.
 *
 * @example
 * ```ts
 * const template = compileAST(parseWithoutProcessing("Hi {{name}}!"), env);
 * template({ name: "Ada" }); // "Hi Ada!"
 * template({ name: "<b>" }, { noEscape: true }); // "Hi <b>!"
 * ```
 */
export const compileAST = <TContext = unknown>(
  program: ParserProgram,
  environment?: Environment,
): TemplateDelegate<TContext> => {
  assertProgram(program);
  return (context?: TContext, options: RuntimeOptions = {}): string =>
    evaluateProgram(program, context, environment === undefined ? options : resolveOptions(environment, options));
};

/**
 * Renders a program once, with no environment to set up.
 *
 * @param program - A `Program` from `parseWithoutProcessing`.
 * @param context - The root context (`this` at the top level).
 * @param options - Helpers, partials, decorators, runtime flags, and an optional `parse` for string partials.
 * @returns The rendered output.
 * @throws {@link HandlebarsRuntimeError} with code `invalid-program` when `program` is not a `Program` node.
 *
 * @example
 * ```ts
 * renderAST(parseWithoutProcessing("{{#each items}}{{this}} {{/each}}"), { items: [1, 2] });
 * // "1 2 "
 * ```
 */
export const renderAST = (program: ParserProgram, context?: unknown, options: EnvironmentOptions = {}): string => {
  assertProgram(program);
  return evaluateProgram(program, context, options);
};
