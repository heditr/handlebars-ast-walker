/**
 * The error type thrown by the walker at render time.
 *
 * @packageDocumentation
 */

import type { SourceLocation } from "./types";

/** Machine-readable reasons a render can fail. */
export type RuntimeErrorCode =
  /** Strict mode: a path segment was not present on its parent. */
  "missing-property";

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
