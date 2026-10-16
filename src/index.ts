/**
 * handlebars-ast-walker: a CSP-safe Handlebars 4.7 interpreter that renders
 * a pre-parsed AST without generating code.
 *
 * Parse with `parseWithoutProcessing` from `@handlebars/parser`, then hand
 * the program to {@link renderAST} for a one-off render or to
 * {@link compileAST} for a reusable template. {@link createEnvironment}
 * holds shared helpers, partials, decorators, and default options.
 *
 * @example
 * ```ts
 * import { parseWithoutProcessing } from "@handlebars/parser";
 * import { createEnvironment, compileAST } from "handlebars-ast-walker";
 *
 * const env = createEnvironment({ parse: parseWithoutProcessing });
 * env.registerHelper("upper", (text: unknown) => String(text).toUpperCase());
 *
 * const template = compileAST(parseWithoutProcessing("Hi {{upper name}}!"), env);
 * template({ name: "Ada" }); // "Hi ADA!"
 * ```
 *
 * @packageDocumentation
 */

import { escapeExpression } from "./escape";
import { isEmpty } from "./helpers";
import { createFrame } from "./scope";

export {
  compileAST,
  createEnvironment,
  renderAST,
  type Environment,
  type EnvironmentOptions,
  type ParseFunction,
} from "./environment";
export { HandlebarsRuntimeError, isRuntimeError, type RuntimeErrorCode } from "./errors";
export { escapeExpression, SafeString } from "./escape";
export { isEmpty } from "./helpers";
export { createLogger, type LogOutput } from "./logger";
export { createFrame } from "./scope";
export { processWhitespace, type WhitespaceOptions } from "./whitespace";
export type * from "./types";

/**
 * The subset of `Handlebars.Utils` the walker provides, grouped under the
 * same name so helper code written against Handlebars can keep its
 * `Utils.escapeExpression(...)` calls.
 */
export const Utils = Object.freeze({
  /** HTML-escapes a value; `SafeString` and other `toHTML()` values pass through. */
  escapeExpression,
  /** `true` for `null`, `undefined`, `false`, `""`, and `[]`; `0` is not empty. */
  isEmpty,
  /** Creates a child `@data` frame linked to its parent, like `Handlebars.createFrame`. */
  createFrame,
});
