/**
 * HTML escaping with Handlebars 4.7 semantics.
 *
 * @packageDocumentation
 */

/**
 * Marks a string as already-safe HTML so {@link escapeExpression} emits it
 * verbatim. Kept as a class because Handlebars helpers and consumers rely on
 * `new SafeString(html)` and duck-type it through `toHTML()`.
 *
 * @example
 * ```ts
 * const link = (url: string) =>
 *   new SafeString(`<a href="${escapeExpression(url)}">link</a>`);
 * ```
 */
export class SafeString {
  readonly string: string;

  constructor(string: string) {
    this.string = string;
  }

  toString(): string {
    return String(this.string);
  }

  toHTML(): string {
    return String(this.string);
  }
}

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
  "=": "&#x3D;",
};

const badChars = /[&<>"'`=]/g;
const possible = /[&<>"'`=]/;

const escapeChar = (chr: string): string => escapeMap[chr] ?? chr;

const escapeString = (text: string): string =>
  possible.test(text) ? text.replace(badChars, escapeChar) : text;

const hasToHTML = (value: unknown): value is { toHTML(): unknown } =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { toHTML?: unknown }).toHTML === "function";

/**
 * Converts a value to HTML-safe text exactly like `Handlebars.escapeExpression`.
 *
 * - Strings have `& < > " ' \` =` replaced by entities; strings without any of
 *   those characters are returned as-is.
 * - Objects exposing a `toHTML()` method (such as {@link SafeString}) are
 *   trusted and emitted verbatim.
 * - `null` and `undefined` become `""`.
 * - Every other value is stringified first, so `0` and `false` are preserved.
 *   The one divergence from Handlebars: a `symbol` is stringified instead of
 *   throwing a `TypeError`.
 *
 * @param value - Any template value.
 * @returns Text safe to interpolate into HTML.
 */
export const escapeExpression = (value: unknown): string => {
  if (typeof value !== "string") {
    if (hasToHTML(value)) return String(value.toHTML());
    if (value === null || value === undefined) return "";
    return escapeString(String(value));
  }
  return escapeString(value);
};
