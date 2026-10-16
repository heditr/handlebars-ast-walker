/**
 * The error type thrown by the walker at render time.
 *
 * @packageDocumentation
 */

import type { SourceLocation } from "./types";

/** Machine-readable reasons a render can fail. */
export type RuntimeErrorCode =
  /** Strict mode: a path segment was not present on its parent. */
  | "missing-property"
  /** A built-in helper was called with the wrong number of arguments. */
  | "invalid-arguments"
  /** A helper-shaped call (`{{name arg}}`) named a helper that is not registered. */
  | "missing-helper"
  /** `knownHelpersOnly` is set and a helper-shaped call named an unregistered helper. */
  | "unknown-helper"
  /** A partial name resolved to nothing and no `{{#> }}` fallback body was written. */
  | "missing-partial"
  /** A registered partial is neither a program nor source that the environment can parse. */
  | "invalid-partial"
  /** A `{{* name}}` or `{{#* name}}` referenced a decorator that is not registered. */
  | "missing-decorator"
  /** The AST contained a node the walker does not recognise. */
  | "unknown-node"
  /** `compileAST` or `renderAST` received a value that is not a `Program` node. */
  | "invalid-program";

/**
 * Raised for template-level failures such as strict-mode lookups.
 *
 * Carries a stable {@link RuntimeErrorCode} so callers can branch without
 * parsing messages, and the source location of the offending node when the
 * AST provides one.
 *
 * @example
 * ```ts
 * try {
 *   render(context, { strict: true });
 * } catch (error) {
 *   if (isRuntimeError(error) && error.code === "missing-property") {
 *     console.warn(error.message, error.loc);
 *   }
 * }
 * ```
 */
export class HandlebarsRuntimeError extends Error {
  override readonly name = "HandlebarsRuntimeError";
  readonly code: RuntimeErrorCode;
  readonly loc: SourceLocation | undefined;

  constructor(
    message: string,
    { code, loc }: { code: RuntimeErrorCode; loc?: SourceLocation | undefined },
  ) {
    super(message);
    this.code = code;
    this.loc = loc;
  }
}

/**
 * Type guard for {@link HandlebarsRuntimeError}.
 *
 * @param error - Any caught value.
 */
export const isRuntimeError = (error: unknown): error is HandlebarsRuntimeError =>
  error instanceof HandlebarsRuntimeError;
