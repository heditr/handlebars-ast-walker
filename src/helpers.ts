/**
 * Built-in helpers ported from Handlebars 4.7.10: `if`, `unless`, `each`,
 * `with`, `lookup`, `log`, `helperMissing`, and `blockHelperMissing`.
 *
 * Each helper is a plain {@link HelperDelegate} so it can be registered,
 * wrapped, or replaced like any user helper. Behaviour matches Handlebars
 * exactly, including the error messages; the only omission is `contextPath`
 * bookkeeping, which belongs to the `trackIds` compile option this walker
 * does not implement.
 *
 * @packageDocumentation
 */

import { HandlebarsRuntimeError } from "./errors";
import { defaultLogger } from "./logger";
import { createFrame } from "./scope";
import type {
  DataFrame,
  HelperDelegate,
  HelperMap,
  HelperOptions,
  Logger,
  SourceLocation,
} from "./types";

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Handlebars' notion of "empty": every falsy value except `0`, plus empty
 * arrays. Drives `#if`, `#unless`, and `#with`. Note that `{}` and `""`
 * differ: an empty object is not empty, an empty string is.
 *
 * @param value - Any template value.
 * @returns `true` when a block helper should take its inverse branch.
 */
export const isEmpty = (value: unknown): boolean =>
  (!value && value !== 0) || (Array.isArray(value) && value.length === 0);

/** Narrows to a callable so it can be invoked with an explicit `this`. */
const isFunction = (value: unknown): value is (this: unknown) => unknown =>
  typeof value === "function";

/**
 * Applies the Handlebars lambda rule for helper arguments: a function is
 * called with the current context as `this` and its result is used instead.
 */
const resolveLambda = (value: unknown, thisArg: unknown): unknown =>
  isFunction(value) ? value.call(thisArg) : value;

/** The `loc` of the trailing options argument, when the call carries one. */
const locOf = (args: readonly unknown[]): SourceLocation | undefined => {
  const last = args[args.length - 1];
  return last !== null && typeof last === "object" ? (last as HelperOptions).loc : undefined;
};

/** Builds the arity error a built-in helper throws, located at the call site when known. */
const invalidArguments = (message: string, args: readonly unknown[]): HandlebarsRuntimeError =>
  new HandlebarsRuntimeError(message, { code: "invalid-arguments", loc: locOf(args) });

// ---------------------------------------------------------------------------
// if / unless
// ---------------------------------------------------------------------------

/**
 * `{{#if value}}...{{else}}...{{/if}}`.
 *
 * Renders the block when `value` is truthy and not {@link isEmpty}, otherwise
 * the inverse. `includeZero=true` in the hash lets `0` take the block. A
 * function value is called with the context as `this` first.
 *
 * Declared with rest arguments because Handlebars validates the arity: both
 * `{{#if}}` and `{{#if a b}}` throw.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` unless exactly one value is passed.
 */
export const ifHelper: HelperDelegate = function (this: unknown, ...args: unknown[]): string {
  if (args.length !== 2) throw invalidArguments("#if requires exactly one argument", args);
  const [value, options] = args as [unknown, HelperOptions];
  const conditional = resolveLambda(value, this);
  const takeInverse = (!options.hash.includeZero && !conditional) || isEmpty(conditional);
  return takeInverse ? options.inverse(this) : options.fn(this);
};

/**
 * `{{#unless value}}...{{else}}...{{/unless}}`: {@link ifHelper} with the
 * block and inverse swapped. The hash (including `includeZero`) is forwarded.
 *
 * Delegates to the built-in `if` directly, not to whatever `if` is registered
 * at render time; override `unless` as well if you replace `if`.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` unless exactly one value is passed.
 */
export const unlessHelper: HelperDelegate = function (this: unknown, ...args: unknown[]): string {
  if (args.length !== 2) throw invalidArguments("#unless requires exactly one argument", args);
  const [conditional, options] = args as [unknown, HelperOptions];
  return ifHelper.call(this, conditional, {
    ...options,
    fn: options.inverse,
    inverse: options.fn,
  }) as string;
};

// ---------------------------------------------------------------------------
// with
// ---------------------------------------------------------------------------

/**
 * `{{#with value as |alias|}}...{{else}}...{{/with}}`.
 *
 * Renders the block with `value` as the context and as the first block
 * parameter; renders the inverse with the current context when `value` is
 * {@link isEmpty}. A function value is called with the context as `this`.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` unless exactly one value is passed.
 */
export const withHelper: HelperDelegate = function (this: unknown, ...args: unknown[]): string {
  if (args.length !== 2) throw invalidArguments("#with requires exactly one argument", args);
  const [value, options] = args as [unknown, HelperOptions];
  const context = resolveLambda(value, this);
  return isEmpty(context)
    ? options.inverse(this)
    : options.fn(context, { data: options.data, blockParams: [context] });
};

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

/**
 * `{{lookup object key}}`: reads `object[key]` through `options.lookupProperty`,
 * so the prototype-access rules apply. A falsy `object` is returned as-is,
 * matching Handlebars 4 (which only short-circuits on `null` in 5.0).
 *
 * The key is stringified before the read, which is what property access
 * does anyway; a `symbol` key is the one (template-unreachable) difference.
 */
export const lookupHelper: HelperDelegate = (subject: unknown, key: unknown, options: unknown): unknown => {
  if (!subject) return subject;
  return (options as HelperOptions).lookupProperty(subject, String(key));
};

// ---------------------------------------------------------------------------
// each
// ---------------------------------------------------------------------------

type IterationRenderer = (key: number | string, index: number, last: boolean, value: unknown) => void;

/**
 * Closes an iterator that was abandoned because the block body threw, as
 * `for...of` would, so generators run their `finally` blocks. Errors from
 * closing are swallowed: the body's error is the one the caller must see.
 */
const closeIterator = (iterator: Iterator<unknown>): void => {
  try {
    iterator.return?.();
  } catch {
    // The body's error takes precedence.
  }
};

/** Iterates an array, skipping holes but keeping their indices. Returns the array length. */
const eachArray = (items: readonly unknown[], render: IterationRenderer): number => {
  const last = items.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i in items) render(i, i, i === last, items[i]);
  }
  return items.length;
};

/**
 * Iterates any iterable one step ahead of the body so `@last` is known
 * without buffering. Returns the number of items rendered.
 */
const eachIterable = (iterable: Iterable<unknown>, render: IterationRenderer): number => {
  const iterator = iterable[Symbol.iterator]();
  let count = 0;
  let current = iterator.next();
  while (!current.done) {
    const next = iterator.next();
    try {
      render(count, count, next.done === true, current.value);
    } catch (error) {
      if (!next.done) closeIterator(iterator);
      throw error;
    }
    current = next;
    count++;
  }
  return count;
};

/** Iterates an object's own enumerable keys in insertion order. Returns the key count. */
const eachObject = (object: Record<string, unknown>, render: IterationRenderer): number => {
  const keys = Object.keys(object);
  const last = keys.length - 1;
  for (let i = 0; i <= last; i++) {
    const key = keys[i] as string;
    render(key, i, i === last, object[key]);
  }
  return keys.length;
};

/** `true` for objects exposing `Symbol.iterator`, such as `Map`, `Set`, and generators. */
const isIterable = (value: object): value is Iterable<unknown> =>
  typeof (value as Partial<Iterable<unknown>>)[Symbol.iterator] === "function";

/**
 * `{{#each collection as |value key|}}...{{else}}...{{/each}}`.
 *
 * Iterates arrays (holes skipped), iterables such as `Map`, `Set`, and
 * generators (checked after arrays, as Handlebars does), and otherwise the
 * own enumerable keys of an object. Each iteration renders the block with
 * the item as context, `[item, key]` as block parameters, and one shared
 * child data frame carrying `@index`, `@key`, `@first`, and `@last`. The
 * inverse renders with the current context when nothing was iterated.
 *
 * One frame and one two-element block-parameter array per iteration are the
 * only allocations in the loop.
 *
 * @throws {@link HandlebarsRuntimeError} with code `invalid-arguments` for `{{#each}}` with no collection.
 */
export const eachHelper: HelperDelegate = function (
  this: unknown,
  subject: unknown,
  options?: HelperOptions,
): string {
  if (!options) throw invalidArguments("Must pass iterator to #each", [subject]);
  const { fn, inverse } = options;
  const context = resolveLambda(subject, this);
  const data: DataFrame | undefined = options.data === undefined ? undefined : createFrame(options.data);
  let output = "";

  const render: IterationRenderer = (key, index, last, value) => {
    if (data !== undefined) {
      data.key = key;
      data.index = index;
      data.first = index === 0;
      data.last = last;
    }
    output += fn(value, { data, blockParams: [value, key] });
  };

  let count = 0;
  if (context !== null && typeof context === "object") {
    count = Array.isArray(context)
      ? eachArray(context, render)
      : isIterable(context)
        ? eachIterable(context, render)
        : eachObject(context as Record<string, unknown>, render);
  }
  return count === 0 ? inverse(this) : output;
};

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/** Coerces a `level=` hash value the way the logger's comparison would. */
const toLogLevel = (level: unknown): number | string =>
  typeof level === "string" || typeof level === "number" ? level : Number(level);

/**
 * Creates the `{{log message... level="warn"}}` helper bound to a logger.
 *
 * The level comes from the `level` hash argument, then `@level` in the data
 * frame, then defaults to `1` (info). Every positional argument is forwarded
 * as a separate log message.
 *
 * @param logger - Receives the messages. Defaults to the package logger.
 */
export const createLogHelper =
  (logger: Logger = defaultLogger): HelperDelegate =>
  (...args: unknown[]): void => {
    const options = args[args.length - 1] as HelperOptions;
    const level = options.hash.level ?? options.data?.level ?? 1;
    logger.log(toLogLevel(level), ...args.slice(0, -1));
  };

// ---------------------------------------------------------------------------
// helperMissing / blockHelperMissing
// ---------------------------------------------------------------------------

/**
 * Called for `{{name}}` and `{{name arg}}` when `name` is neither a helper
 * nor a context property. A bare reference is a missing field and yields
 * `undefined`; a call with arguments is a programming error.
 *
 * @throws {@link HandlebarsRuntimeError} with code `missing-helper` when parameters were passed.
 */
export const helperMissing: HelperDelegate = (...args: unknown[]): undefined => {
  if (args.length === 1) return undefined;
  const options = args[args.length - 1] as HelperOptions;
  throw new HandlebarsRuntimeError(`Missing helper: "${options.name}"`, {
    code: "missing-helper",
    loc: options.loc,
  });
};

/**
 * Called for `{{#name}}...{{/name}}` when `name` resolves to a context value
 * rather than a helper. Implements Mustache section semantics: `true` renders
 * the block, `false`/`null`/`undefined` the inverse, a non-empty array
 * iterates like `#each`, an empty array renders the inverse, and any other
 * value becomes the block's context.
 *
 * Arrays are delegated to the built-in `each` directly, not to whatever
 * `each` is registered at render time.
 */
export const blockHelperMissing: HelperDelegate = function (
  this: unknown,
  context: unknown,
  options: HelperOptions,
): string {
  const { fn, inverse } = options;
  if (context === true) return fn(this);
  if (context === false || context === null || context === undefined) return inverse(this);
  if (Array.isArray(context)) {
    return context.length > 0 ? (eachHelper.call(this, context, options) as string) : inverse(this);
  }
  return fn(context, { data: options.data });
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Builds a fresh registry of the built-in helpers under their Handlebars
 * names. A new object is returned on every call so a render that replaces a
 * helper cannot affect another render.
 *
 * @param options.logger - Logger used by `{{log}}`. Defaults to the package logger.
 * @returns A {@link HelperMap} ready to be merged with user helpers.
 *
 * @example
 * ```ts
 * const helpers = { ...createBuiltinHelpers({ logger }), ...userHelpers };
 * ```
 */
export const createBuiltinHelpers = ({ logger }: { logger?: Logger | undefined } = {}): HelperMap => ({
  blockHelperMissing,
  each: eachHelper,
  helperMissing,
  if: ifHelper,
  log: createLogHelper(logger),
  lookup: lookupHelper,
  unless: unlessHelper,
  with: withHelper,
});
