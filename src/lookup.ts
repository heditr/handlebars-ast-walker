/**
 * Secure property access with the Handlebars 4.7 prototype-access rules.
 *
 * @packageDocumentation
 */

import { defaultLogger } from "./logger";
import type { Logger, LookupProperty, RuntimeOptions } from "./types";

/** The runtime options that govern prototype access, plus the warning sink. */
export type LookupPropertyOptions = Pick<
  RuntimeOptions,
  | "allowProtoPropertiesByDefault"
  | "allowProtoMethodsByDefault"
  | "allowedProtoProperties"
  | "allowedProtoMethods"
> & { logger?: Logger };

/** Allow-list for one kind of inherited member (data properties or methods). */
interface AccessList {
  /** Per-name verdicts. A null-prototype object so inherited keys never match. */
  readonly allowed: Record<string, boolean | undefined>;
  /** Verdict for names not in `allowed`; `undefined` means deny and warn. */
  readonly defaultValue: boolean | undefined;
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Builds a null-prototype allow-list from built-in denials and user overrides.
 *
 * @param denied - Names denied unless the user explicitly allows them.
 * @param overrides - User-supplied per-name verdicts.
 * @param defaultValue - Verdict for names that appear in neither list.
 */
const createAccessList = (
  denied: readonly string[],
  overrides: Record<string, boolean> = {},
  defaultValue?: boolean,
): AccessList => ({
  allowed: Object.assign(
    Object.create(null) as Record<string, boolean | undefined>,
    Object.fromEntries(denied.map((name) => [name, false])),
    overrides,
  ),
  defaultValue,
});

/**
 * Detects a prototype object's own `constructor` back-reference, such as
 * `Function.prototype.constructor === Function`. It is an own property, so
 * without this check it would bypass the inherited-member rules and expose
 * `Function`.
 */
const isPrototypeConstructor = (parent: unknown, propertyName: string, result: unknown): boolean =>
  propertyName === "constructor" &&
  typeof result === "function" &&
  parent === (result as { prototype?: unknown }).prototype;

const deniedMessage = (propertyName: string): string =>
  `Handlebars: Access has been denied to resolve the property "${propertyName}" because it is not an "own property" of its parent.\n` +
  "You can add a runtime option to disable the check or this warning:\n" +
  "See https://handlebarsjs.com/api-reference/runtime-options.html#options-to-control-prototype-access for details";

/**
 * Creates the `lookupProperty` function used for every property read during
 * a render and handed to helpers through `options.lookupProperty`.
 *
 * Rules, in order:
 * 1. A `null` or `undefined` parent yields `undefined`.
 * 2. A `null` or `undefined` value is returned as-is.
 * 3. Own properties are returned, except a prototype object's own
 *    `constructor`, which is treated as an inherited method.
 * 4. Inherited members pass only through the allow-lists: per-name entries
 *    first, then `allowProto*ByDefault`. `__proto__`, `constructor`, and the
 *    legacy `__define*__` / `__lookup*__` accessors are denied unless named
 *    explicitly.
 * 5. A denial with no explicit default is logged at `error` level once per
 *    property name for this lookup instance.
 *
 * Primitive parents are supported so `{{name.length}}` works on strings.
 *
 * @param options - Prototype-access runtime options and an optional logger.
 * @returns A {@link LookupProperty}.
 *
 * @example
 * ```ts
 * const lookupProperty = createLookupProperty({ allowedProtoMethods: { toJSON: true } });
 * lookupProperty(new Date(0), "toJSON"); // the Date method
 * lookupProperty(new Date(0), "getTime"); // undefined
 * ```
 */
export const createLookupProperty = ({
  allowProtoPropertiesByDefault,
  allowProtoMethodsByDefault,
  allowedProtoProperties,
  allowedProtoMethods,
  logger = defaultLogger,
}: LookupPropertyOptions = {}): LookupProperty => {
  const properties = createAccessList(
    ["__proto__"],
    allowedProtoProperties,
    allowProtoPropertiesByDefault,
  );
  const methods = createAccessList(
    ["constructor", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"],
    allowedProtoMethods,
    allowProtoMethodsByDefault,
  );
  const logged = new Set<string>();

  const isAllowed = ({ allowed, defaultValue }: AccessList, propertyName: string): boolean => {
    const verdict = allowed[propertyName];
    if (verdict !== undefined) return verdict;
    if (defaultValue !== undefined) return defaultValue;
    if (!logged.has(propertyName)) {
      logged.add(propertyName);
      logger.log("error", deniedMessage(propertyName));
    }
    return false;
  };

  return (parent, propertyName) => {
    if (parent === null || parent === undefined) return undefined;
    const result = (parent as Record<string, unknown>)[propertyName];
    if (result === null || result === undefined) return result;
    if (hasOwn.call(parent, propertyName) && !isPrototypeConstructor(parent, propertyName, result)) {
      return result;
    }
    const list = typeof result === "function" ? methods : properties;
    return isAllowed(list, propertyName) ? result : undefined;
  };
};
