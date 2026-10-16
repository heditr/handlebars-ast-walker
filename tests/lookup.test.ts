import { describe, expect, test, vi } from "vitest";
import Handlebars from "handlebars";

import { createLookupProperty } from "../src/lookup";
import type { Logger } from "../src/types";

/** A logger that records calls so tests can assert on access warnings. */
const createRecordingLogger = () => {
  const log = vi.fn<Logger["log"]>();
  const logger: Logger & { log: typeof log } = { level: "info", log };
  return logger;
};

/** An instance whose `inherited` field and `greet` method live on the prototype. */
const createInstanceWithPrototype = () => {
  const proto = { inherited: "from-proto", greet: () => "hi" };
  return Object.assign(Object.create(proto) as { inherited: string; greet(): string }, {
    own: "from-own",
  });
};

describe("createLookupProperty", () => {
  test("given an own property, should return its value", () => {
    const lookupProperty = createLookupProperty();

    expect(lookupProperty({ name: "Ada" }, "name")).toBe("Ada");
  });

  test("given an own property holding null, should return null rather than undefined", () => {
    const lookupProperty = createLookupProperty();

    expect(lookupProperty({ value: null }, "value")).toBeNull();
  });

  test("given a null or undefined parent, should return undefined instead of throwing", () => {
    const lookupProperty = createLookupProperty();

    expect(lookupProperty(null, "x")).toBeUndefined();
    expect(lookupProperty(undefined, "x")).toBeUndefined();
  });

  test("given a primitive parent, should read its own properties like Handlebars does", () => {
    const lookupProperty = createLookupProperty();

    expect(lookupProperty("abc", "length")).toBe(3);
    expect(lookupProperty("abc", "1")).toBe("b");
  });

  test("given an inherited data property with default options, should deny access", () => {
    const lookupProperty = createLookupProperty({ logger: createRecordingLogger() });

    expect(lookupProperty(createInstanceWithPrototype(), "inherited")).toBeUndefined();
    expect(lookupProperty(createInstanceWithPrototype(), "own")).toBe("from-own");
  });

  test("given an inherited method with default options, should deny access", () => {
    const lookupProperty = createLookupProperty({ logger: createRecordingLogger() });

    expect(lookupProperty(createInstanceWithPrototype(), "greet")).toBeUndefined();
    expect(lookupProperty("abc", "toUpperCase")).toBeUndefined();
  });

  test("given allowProtoPropertiesByDefault, should allow inherited data but still deny inherited methods", () => {
    const lookupProperty = createLookupProperty({
      allowProtoPropertiesByDefault: true,
      logger: createRecordingLogger(),
    });

    expect(lookupProperty(createInstanceWithPrototype(), "inherited")).toBe("from-proto");
    expect(lookupProperty(createInstanceWithPrototype(), "greet")).toBeUndefined();
  });

  test("given allowProtoMethodsByDefault, should allow inherited methods but still deny inherited data", () => {
    const lookupProperty = createLookupProperty({
      allowProtoMethodsByDefault: true,
      logger: createRecordingLogger(),
    });

    expect(lookupProperty(createInstanceWithPrototype(), "greet")).toBeTypeOf("function");
    expect(lookupProperty(createInstanceWithPrototype(), "inherited")).toBeUndefined();
  });

  test("given per-name allow lists, should override the defaults in both directions", () => {
    const lookupProperty = createLookupProperty({
      allowProtoPropertiesByDefault: true,
      allowedProtoProperties: { inherited: false },
      allowedProtoMethods: { greet: true },
    });

    expect(lookupProperty(createInstanceWithPrototype(), "inherited")).toBeUndefined();
    expect(lookupProperty(createInstanceWithPrototype(), "greet")).toBeTypeOf("function");
  });

  test("given __proto__, should deny it even when inherited properties are allowed by default", () => {
    const lookupProperty = createLookupProperty({ allowProtoPropertiesByDefault: true });

    expect(lookupProperty({}, "__proto__")).toBeUndefined();
  });

  test("given constructor and the getter/setter helpers, should deny them even when inherited methods are allowed by default", () => {
    const lookupProperty = createLookupProperty({ allowProtoMethodsByDefault: true });

    expect(lookupProperty({}, "constructor")).toBeUndefined();
    expect(lookupProperty({}, "__defineGetter__")).toBeUndefined();
    expect(lookupProperty({}, "__defineSetter__")).toBeUndefined();
    expect(lookupProperty({}, "__lookupGetter__")).toBeUndefined();
    expect(lookupProperty({}, "__lookupSetter__")).toBeUndefined();
  });

  test("given a prototype object's own constructor back-reference, should deny it despite being an own property", () => {
    const lookupProperty = createLookupProperty();
    class Widget {}

    expect(Object.prototype.hasOwnProperty.call(Widget.prototype, "constructor")).toBe(true);
    expect(lookupProperty(Widget.prototype, "constructor")).toBeUndefined();
    expect(lookupProperty(Function.prototype, "constructor")).toBeUndefined();
  });

  test("given a prototype object's own constructor and an explicit allow entry, should return it", () => {
    const lookupProperty = createLookupProperty({ allowedProtoMethods: { constructor: true } });
    class Widget {}

    expect(lookupProperty(Widget.prototype, "constructor")).toBe(Widget);
  });

  test("given an own property that merely happens to be named constructor, should allow it", () => {
    const lookupProperty = createLookupProperty();

    expect(lookupProperty({ constructor: "plain" }, "constructor")).toBe("plain");
  });

  test("given a denied inherited access with no explicit default, should log an error once per property name", () => {
    const logger = createRecordingLogger();
    const lookupProperty = createLookupProperty({ logger });

    lookupProperty(createInstanceWithPrototype(), "inherited");
    lookupProperty(createInstanceWithPrototype(), "inherited");
    lookupProperty(createInstanceWithPrototype(), "greet");

    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.log.mock.calls[0]?.[0]).toBe("error");
    expect(String(logger.log.mock.calls[0]?.[1])).toContain('"inherited"');
    expect(String(logger.log.mock.calls[1]?.[1])).toContain('"greet"');
  });

  test("given an explicit default of false, should deny silently without logging", () => {
    const logger = createRecordingLogger();
    const lookupProperty = createLookupProperty({
      allowProtoPropertiesByDefault: false,
      allowProtoMethodsByDefault: false,
      logger,
    });

    lookupProperty(createInstanceWithPrototype(), "inherited");
    lookupProperty(createInstanceWithPrototype(), "greet");

    expect(logger.log).not.toHaveBeenCalled();
  });
});

describe("createLookupProperty: Handlebars 4.7 parity", () => {
  const render = (template: string, context: unknown, options: Handlebars.RuntimeOptions = {}) =>
    Handlebars.compile(template)(context, options);

  test("given an inherited property, should match Handlebars with and without the allow option", () => {
    const lookupDefault = createLookupProperty({ logger: createRecordingLogger() });
    const lookupAllowed = createLookupProperty({ allowProtoPropertiesByDefault: true });

    expect(String(lookupDefault(createInstanceWithPrototype(), "inherited") ?? "")).toBe(
      render("{{inherited}}", createInstanceWithPrototype()),
    );
    expect(String(lookupAllowed(createInstanceWithPrototype(), "inherited"))).toBe(
      render("{{inherited}}", createInstanceWithPrototype(), {
        allowProtoPropertiesByDefault: true,
      }),
    );
  });

  test("given a prototype's own constructor, should match Handlebars by rendering nothing", () => {
    class Widget {}
    const lookupProperty = createLookupProperty();

    expect(String(lookupProperty(Widget.prototype, "constructor") ?? "")).toBe(
      render("{{proto.constructor}}", { proto: Widget.prototype }),
    );
  });
});
