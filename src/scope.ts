/**
 * Scope chain, block parameters, `@data` frames, and path resolution.
 *
 * A {@link Scope} is an immutable linked frame: pushing a block body creates
 * a new frame that points at its parent, so nothing is copied and nothing
 * has to be popped. Helper `fn` / `inverse` closures capture the frame they
 * were created in, which keeps `../` correct even when a helper calls `fn`
 * after other blocks have rendered.
 *
 * @packageDocumentation
 */

import { HandlebarsRuntimeError } from "./errors";
import type {
  DataFrame,
  LookupProperty,
  PathExpression,
  RuntimeOptions,
  SourceLocation,
} from "./types";

// ---------------------------------------------------------------------------
// Scope chain
// ---------------------------------------------------------------------------

/** Names declared with `as |a b|` on one block, with the values a helper bound to them. */
export interface BlockParamFrame {
  readonly names: readonly string[];
  readonly values: readonly unknown[];
  readonly parent: BlockParamFrame | undefined;
}

/** One level of the context chain. */
export interface Scope {
  /** The value of `this` at this level. */
  readonly context: unknown;
  /** The `@data` frame in effect; `undefined` when data tracking is disabled. */
  readonly data: DataFrame | undefined;
  /** The level `../` refers to. */
  readonly parent: Scope | undefined;
  /** Innermost block-parameter frame visible from here. */
  readonly blockParams: BlockParamFrame | undefined;
}

/**
 * Creates the root scope for a render.
 *
 * @param options.context - The root context (`this` at the top level).
 * @param options.data - The root `@data` frame, or omit to disable data tracking.
 */
export const createScope = ({
  context,
  data,
}: { context?: unknown; data?: DataFrame | undefined } = {}): Scope => ({
  context,
  data,
  parent: undefined,
  blockParams: undefined,
});

/** Handlebars compares contexts loosely, so `null` and `undefined` count as the same frame. */
const isSameContext = (a: unknown, b: unknown): boolean =>
  a === b || (a === null && b === undefined) || (a === undefined && b === null);

/**
 * Enters a block body.
 *
 * A new `../` level is added only when `context` differs from the current
 * one; blocks that keep `this` (such as `{{#if}}`) are transparent to `../`,
 * exactly as in Handlebars 4.
 *
 * @param scope - The enclosing scope.
 * @param options.context - The block's `this`.
 * @param options.data - The block's `@data` frame. Defaults to the enclosing frame.
 * @param options.blockParams - Names declared on the block and the values bound to them.
 * @returns The scope for the block body.
 *
 * @example
 * ```ts
 * const body = pushScope(scope, {
 *   context: item,
 *   data: frame,
 *   blockParams: { names: program.blockParams ?? [], values: [item, index] },
 * });
 * ```
 */
export const pushScope = (
  scope: Scope,
  {
    context,
    data = scope.data,
    blockParams,
  }: {
    context: unknown;
    data?: DataFrame | undefined;
    blockParams?: { names: readonly string[]; values: readonly unknown[] } | undefined;
  },
): Scope => ({
  context,
  data,
  parent: isSameContext(context, scope.context) ? scope.parent : scope,
  blockParams:
    blockParams !== undefined && blockParams.names.length > 0
      ? { names: blockParams.names, values: blockParams.values, parent: scope.blockParams }
      : scope.blockParams,
});

/**
 * Returns a scope with the same context chain and data but no visible block
 * parameters. Partials are rendered in such a scope because block parameters
 * are lexical to the template that declares them.
 */
export const withoutBlockParams = (scope: Scope): Scope =>
  scope.blockParams === undefined ? scope : { ...scope, blockParams: undefined };

/**
 * The context `depth` levels up: `0` is `this`, `1` is `../`, and so on.
 * Returns `undefined` past the root.
 */
export const contextAt = (scope: Scope | undefined, depth: number): unknown =>
  scope === undefined
    ? undefined
    : depth === 0
      ? scope.context
      : contextAt(scope.parent, depth - 1);

/** A block-parameter hit. Distinguishes "declared but undefined" from "not declared". */
export interface BlockParamMatch {
  readonly value: unknown;
}

const findInFrame = (
  frame: BlockParamFrame | undefined,
  name: string,
): BlockParamMatch | undefined => {
  if (frame === undefined) return undefined;
  const index = frame.names.indexOf(name);
  return index >= 0 ? { value: frame.values[index] } : findInFrame(frame.parent, name);
};

/**
 * Looks a name up in the block parameters visible from `scope`, innermost
 * block first.
 *
 * @returns The bound value, or `undefined` when no enclosing block declares `name`.
 */
export const findBlockParam = (scope: Scope, name: string): BlockParamMatch | undefined =>
  findInFrame(scope.blockParams, name);

/** `true` for paths written as `this`, `this.x`, `.`, or `./x`. Mirrors Handlebars' `scopedId`. */
export const isScopedPath = (path: PathExpression): boolean => /^\.|this\b/.test(path.original);

/**
 * Whether `path` reads a block parameter: it has no `../`, is not scoped
 * with `this` or `./`, and its first segment is a declared block parameter.
 *
 * Handlebars performs this check before looking at the `@` prefix, so
 * `{{@item}}` resolves to a block parameter named `item` when one is in
 * scope. That quirk is preserved for parity.
 */
export const isBlockParamPath = (scope: Scope, path: PathExpression): boolean => {
  const [head] = path.parts;
  return (
    path.depth === 0 &&
    head !== undefined &&
    !isScopedPath(path) &&
    findBlockParam(scope, head) !== undefined
  );
};

// ---------------------------------------------------------------------------
// Data frames
// ---------------------------------------------------------------------------

/**
 * Creates a `@data` frame from `parent`: a shallow copy of its own keys plus
 * a `_parent` link, identical to `Handlebars.createFrame`.
 *
 * @param parent - The frame to inherit from. Omit for the root frame.
 */
export const createFrame = (parent?: DataFrame): DataFrame => ({ ...parent, _parent: parent });

/**
 * The frame `depth` levels up, following `_parent` links. Used by `@../x`.
 * Returns `undefined` past the root or when data tracking is disabled.
 */
export const dataAt = (frame: DataFrame | undefined, depth: number): DataFrame | undefined =>
  frame === undefined || depth === 0 ? frame : dataAt(frame._parent, depth - 1);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Options for {@link resolvePath}. `strict` and `compat` are the runtime options of the same name. */
export interface ResolvePathOptions extends Pick<RuntimeOptions, "strict" | "compat"> {
  lookupProperty: LookupProperty;
  /**
   * `true` for helper parameters and hash values. In strict mode Handlebars
   * only throws for a missing final segment on the expression head
   * (`{{a.b}}`), not on arguments (`{{helper a.b}}`).
   */
  optional?: boolean;
}

interface WalkOptions {
  readonly lookupProperty: LookupProperty;
  readonly strict: boolean;
  /** Strict mode: throw when the final segment is absent from its parent. */
  readonly requireTerminal: boolean;
  /** `@data` semantics: stop at any falsy value instead of only `null`/`undefined`. */
  readonly falsy: boolean;
  readonly loc: SourceLocation | undefined;
}

const describeParent = (parent: unknown): string =>
  parent !== null && typeof parent === "object"
    ? Object.prototype.toString.call(parent)
    : String(parent);

const missingProperty = (name: string, parent: unknown, loc: SourceLocation | undefined) =>
  new HandlebarsRuntimeError(`"${name}" not defined in ${describeParent(parent)}`, {
    code: "missing-property",
    loc,
  });

const strictStep = (
  parent: unknown,
  name: string,
  terminal: boolean,
  { lookupProperty, loc }: WalkOptions,
): unknown => {
  const absent =
    parent === null ||
    parent === undefined ||
    (terminal && (!parent || !(name in Object(parent))));
  if (absent) throw missingProperty(name, parent, loc);
  return lookupProperty(parent, name);
};

const step = (parent: unknown, name: string, { lookupProperty, falsy }: WalkOptions): unknown => {
  if (falsy) return parent ? lookupProperty(parent, name) : parent;
  return parent === null || parent === undefined ? parent : lookupProperty(parent, name);
};

/** Reads `parts[start..]` from `base`, one segment at a time. */
const walk = (base: unknown, parts: readonly string[], start: number, options: WalkOptions): unknown => {
  const last = parts.length - 1;
  let current = base;
  for (let i = start; i <= last; i++) {
    const name = parts[i] as string;
    current = options.strict
      ? strictStep(current, name, options.requireTerminal && i === last, options)
      : step(current, name, options);
  }
  return current;
};

/** Mustache-compatible fallback: the first ancestor context that has `name`. */
const lookupInAncestors = (
  scope: Scope | undefined,
  name: string,
  lookupProperty: LookupProperty,
): unknown => {
  if (scope === undefined) return undefined;
  const { context, parent } = scope;
  const result =
    context === null || context === undefined ? undefined : lookupProperty(context, name);
  return result === null || result === undefined
    ? lookupInAncestors(parent, name, lookupProperty)
    : result;
};

/**
 * Evaluates a {@link PathExpression} against a scope with Handlebars 4.7
 * semantics.
 *
 * Resolution order mirrors the Handlebars compiler:
 * 1. A block parameter, when {@link isBlockParamPath} holds.
 * 2. `this`, `.`, or `..` alone: the context at `path.depth`.
 * 3. `@data` paths: the frame at `path.depth`, then each segment.
 * 4. Context paths: the context at `path.depth`, then each segment. With
 *    `compat`, an unscoped depth-0 head falls back to ancestor contexts.
 *
 * Outside strict mode a `null`/`undefined` intermediate ends the walk and
 * is returned as-is. In strict mode a missing segment throws a
 * {@link HandlebarsRuntimeError} with code `missing-property`. One
 * deliberate difference: strict lookups on primitives (`{{str.length}}`)
 * succeed here, where Handlebars crashes with a `TypeError` from using
 * `in` on a non-object.
 *
 * @param scope - The current scope.
 * @param path - The path node to evaluate.
 * @param options - Property access and mode flags.
 * @returns The resolved value, unescaped and uncalled.
 *
 * @example
 * ```ts
 * resolvePath(scope, path, { lookupProperty, strict: options.strict });
 * ```
 */
export const resolvePath = (
  scope: Scope,
  path: PathExpression,
  { lookupProperty, strict = false, compat = false, optional = false }: ResolvePathOptions,
): unknown => {
  const { parts, depth, loc } = path;
  const base: WalkOptions = { lookupProperty, strict, requireTerminal: false, falsy: false, loc };
  const [head] = parts;

  if (isBlockParamPath(scope, path)) {
    return walk(findBlockParam(scope, head as string)?.value, parts, 1, base);
  }
  if (head === undefined) return contextAt(scope, depth);

  const requireTerminal = strict && !optional;
  if (path.data) {
    return walk(dataAt(scope.data, depth), parts, 0, { ...base, requireTerminal, falsy: true });
  }
  if (compat && depth === 0 && !isScopedPath(path)) {
    return walk(lookupInAncestors(scope, head, lookupProperty), parts, 1, { ...base, requireTerminal });
  }
  return walk(contextAt(scope, depth), parts, 0, { ...base, requireTerminal });
};
