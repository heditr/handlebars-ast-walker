import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";
import { parseWithoutProcessing } from "@handlebars/parser";

import { isRuntimeError } from "../src/errors";
import { createLookupProperty } from "../src/lookup";
import {
  contextAt,
  createFrame,
  createScope,
  dataAt,
  findBlockParam,
  isBlockParamPath,
  isScopedPath,
  pushScope,
  resolvePath,
  withoutBlockParams,
} from "../src/scope";
import type { MustacheStatement, PathExpression } from "../src/types";

/** Parses `{{...}}` and returns the mustache's path node. */
const pathOf = (template: string): PathExpression => {
  const [statement] = parseWithoutProcessing(template).body;
  return (statement as unknown as MustacheStatement).path as PathExpression;
};

const lookupProperty = createLookupProperty();

const resolve = (
  scope: ReturnType<typeof createScope>,
  template: string,
  options: Partial<Parameters<typeof resolvePath>[2]> = {},
) => resolvePath(scope, pathOf(template), { lookupProperty, ...options });

describe("createScope / pushScope / contextAt", () => {
  test("given a fresh scope, should expose the root context at depth 0 and nothing above it", () => {
    const root = { name: "root" };
    const scope = createScope({ context: root });

    expect(contextAt(scope, 0)).toBe(root);
    expect(contextAt(scope, 1)).toBeUndefined();
  });

  test("given a pushed child context, should expose the parent at depth 1 without copying either object", () => {
    const root = { name: "root" };
    const child = { name: "child" };
    const scope = pushScope(createScope({ context: root }), { context: child });

    expect(contextAt(scope, 0)).toBe(child);
    expect(contextAt(scope, 1)).toBe(root);
    expect(contextAt(scope, 2)).toBeUndefined();
  });

  test("given a push of the same context, should not add a depth level, like Handlebars blocks that keep this", () => {
    const root = { name: "root" };
    const child = { name: "child" };
    const scope = pushScope(
      pushScope(createScope({ context: root }), { context: child }),
      { context: child },
    );

    expect(contextAt(scope, 1)).toBe(root);
  });

  test("given no data override, should inherit the parent frame; given one, should use it", () => {
    const rootData = createFrame();
    const childData = createFrame(rootData);
    const inherited = pushScope(createScope({ context: {}, data: rootData }), { context: 1 });
    const overridden = pushScope(inherited, { context: 2, data: childData });

    expect(inherited.data).toBe(rootData);
    expect(overridden.data).toBe(childData);
  });
});

describe("block params", () => {
  test("given declared names and values, should find a parameter by name", () => {
    const user = { name: "Ada" };
    const scope = pushScope(createScope({ context: {} }), {
      context: user,
      blockParams: { names: ["user", "index"], values: [user, 0] },
    });

    expect(findBlockParam(scope, "user")).toEqual({ value: user });
    expect(findBlockParam(scope, "index")).toEqual({ value: 0 });
    expect(findBlockParam(scope, "other")).toBeUndefined();
  });

  test("given a declared name with no value supplied, should report it as found with an undefined value", () => {
    const scope = pushScope(createScope({ context: {} }), {
      context: {},
      blockParams: { names: ["a", "b"], values: [1] },
    });

    expect(findBlockParam(scope, "b")).toEqual({ value: undefined });
  });

  test("given nested declarations, should resolve innermost first while keeping outer names visible", () => {
    const outer = pushScope(createScope({ context: {} }), {
      context: {},
      blockParams: { names: ["x", "y"], values: ["outer-x", "outer-y"] },
    });
    const inner = pushScope(outer, {
      context: {},
      blockParams: { names: ["x"], values: ["inner-x"] },
    });

    expect(findBlockParam(inner, "x")).toEqual({ value: "inner-x" });
    expect(findBlockParam(inner, "y")).toEqual({ value: "outer-y" });
    expect(findBlockParam(outer, "x")).toEqual({ value: "outer-x" });
  });

  test("given a scope stripped of block params, should hide them while keeping the context chain", () => {
    const root = { name: "root" };
    const scope = pushScope(createScope({ context: root }), {
      context: {},
      blockParams: { names: ["x"], values: [1] },
    });
    const stripped = withoutBlockParams(scope);

    expect(findBlockParam(stripped, "x")).toBeUndefined();
    expect(contextAt(stripped, 1)).toBe(root);
  });

  test("given paths written with this or a leading dot, should classify them as scoped", () => {
    expect(isScopedPath(pathOf("{{this.user}}"))).toBe(true);
    expect(isScopedPath(pathOf("{{./user}}"))).toBe(true);
    expect(isScopedPath(pathOf("{{this}}"))).toBe(true);
    expect(isScopedPath(pathOf("{{user}}"))).toBe(false);
    expect(isScopedPath(pathOf("{{thistle}}"))).toBe(false);
  });

  test("given a declared block param, should treat only unscoped depth-0 paths starting with it as block-param paths", () => {
    const scope = pushScope(createScope({ context: {} }), {
      context: {},
      blockParams: { names: ["user"], values: [{}] },
    });

    expect(isBlockParamPath(scope, pathOf("{{user}}"))).toBe(true);
    expect(isBlockParamPath(scope, pathOf("{{user.name}}"))).toBe(true);
    expect(isBlockParamPath(scope, pathOf("{{../user}}"))).toBe(false);
    expect(isBlockParamPath(scope, pathOf("{{this.user}}"))).toBe(false);
    expect(isBlockParamPath(scope, pathOf("{{./user}}"))).toBe(false);
    expect(isBlockParamPath(scope, pathOf("{{other}}"))).toBe(false);
  });

  test("given a @data path whose name is a declared block param, should classify it as a block-param path like Handlebars does", () => {
    const scope = pushScope(createScope({ context: {} }), {
      context: {},
      blockParams: { names: ["item"], values: ["param"] },
    });

    expect(isBlockParamPath(scope, pathOf("{{@item}}"))).toBe(true);
    expect(Handlebars.compile("{{#each items as |item|}}{{@item}}{{/each}}")({ items: ["a"] })).toBe("a");
  });
});

describe("createFrame / dataAt", () => {
  test("given a parent frame, should copy its own keys and link back through _parent", () => {
    const parent = createFrame();
    parent.root = { title: "t" };
    parent.index = 3;
    const frame = createFrame(parent);

    expect(frame.root).toBe(parent.root);
    expect(frame.index).toBe(3);
    expect(frame._parent).toBe(parent);
    expect(Handlebars.createFrame(parent)).toEqual(frame);
  });

  test("given mutation of a child frame, should leave the parent untouched", () => {
    const parent = createFrame();
    parent.index = 0;
    const frame = createFrame(parent);
    frame.index = 1;

    expect(parent.index).toBe(0);
  });

  test("given no parent, should create a root frame whose _parent is undefined", () => {
    expect(createFrame()).toEqual({ _parent: undefined });
  });

  test("given a chain of frames, should walk up by depth and return undefined past the root", () => {
    const root = createFrame();
    const middle = createFrame(root);
    const leaf = createFrame(middle);

    expect(dataAt(leaf, 0)).toBe(leaf);
    expect(dataAt(leaf, 1)).toBe(middle);
    expect(dataAt(leaf, 2)).toBe(root);
    expect(dataAt(leaf, 3)).toBeUndefined();
    expect(dataAt(undefined, 0)).toBeUndefined();
  });
});

describe("resolvePath: context paths", () => {
  test("given this or a lone dot, should return the current context", () => {
    const context = { name: "me" };
    const scope = createScope({ context });

    expect(resolve(scope, "{{this}}")).toBe(context);
    expect(resolve(scope, "{{.}}")).toBe(context);
  });

  test("given a simple or dotted name, should read through lookupProperty", () => {
    const scope = createScope({ context: { user: { address: { city: "Paris" } } } });

    expect(resolve(scope, "{{user}}")).toEqual({ address: { city: "Paris" } });
    expect(resolve(scope, "{{user.address.city}}")).toBe("Paris");
    expect(resolve(scope, "{{this.user.address.city}}")).toBe("Paris");
    expect(resolve(scope, "{{./user.address.city}}")).toBe("Paris");
  });

  test("given a literal segment, should use the bracketed text as one key", () => {
    const scope = createScope({ context: { "foo bar": { "a.b": "ok" } } });

    expect(resolve(scope, "{{[foo bar].[a.b]}}")).toBe("ok");
  });

  test("given a missing intermediate, should return the nullish value it stopped at instead of throwing", () => {
    const scope = createScope({ context: { gone: null } });

    expect(resolve(scope, "{{missing.deeper}}")).toBeUndefined();
    expect(resolve(scope, "{{gone.deeper}}")).toBeNull();
  });

  test("given a non-object context, should still read own properties", () => {
    expect(resolve(createScope({ context: "abc" }), "{{length}}")).toBe(3);
    expect(resolve(createScope({ context: undefined }), "{{name}}")).toBeUndefined();
  });

  test("given ../ segments, should read from ancestor contexts by depth", () => {
    const root = { name: "root", list: [1] };
    const child = { name: "child" };
    const grandchild = { name: "grandchild" };
    const scope = pushScope(pushScope(createScope({ context: root }), { context: child }), {
      context: grandchild,
    });

    expect(resolve(scope, "{{../name}}")).toBe("child");
    expect(resolve(scope, "{{../../name}}")).toBe("root");
    expect(resolve(scope, "{{../../list.length}}")).toBe(1);
    expect(resolve(scope, "{{../../../name}}")).toBeUndefined();
    expect(resolve(scope, "{{..}}")).toBe(child);
  });

  test("given a block that keeps the same context, should make ../ skip it exactly like Handlebars", () => {
    const root = { label: "root", items: [{ label: "item" }] };
    const item = root.items[0];
    const scope = pushScope(pushScope(createScope({ context: root }), { context: item }), {
      context: item,
    });

    expect(resolve(scope, "{{../label}}")).toBe(
      Handlebars.compile("{{#each items}}{{#with this}}{{../label}}{{/with}}{{/each}}")(root),
    );
  });

  test("given a prototype-only property, should deny it through lookupProperty", () => {
    const scope = createScope({ context: Object.create({ secret: "s" }) as object });

    expect(resolve(scope, "{{secret}}")).toBeUndefined();
    expect(resolve(scope, "{{constructor}}")).toBeUndefined();
    expect(resolve(scope, "{{__proto__}}")).toBeUndefined();
  });
});

describe("resolvePath: block params", () => {
  const createEachScope = () => {
    const root = { user: "root-user", users: [{ name: "Ada" }] };
    const user = root.users[0];
    return pushScope(createScope({ context: root }), {
      context: user,
      blockParams: { names: ["user", "i"], values: [user, 0] },
    });
  };

  test("given a block param name, should resolve it and any trailing segments against its value", () => {
    const scope = createEachScope();

    expect(resolve(scope, "{{user}}")).toEqual({ name: "Ada" });
    expect(resolve(scope, "{{user.name}}")).toBe("Ada");
    expect(resolve(scope, "{{i}}")).toBe(0);
  });

  test("given ../ or this before a block param name, should read the context instead of the block param", () => {
    const scope = createEachScope();

    expect(resolve(scope, "{{../user}}")).toBe("root-user");
    expect(resolve(scope, "{{this.user}}")).toBeUndefined();
    expect(resolve(scope, "{{this.name}}")).toBe("Ada");
  });

  test("given a block param that shadows a context field, should match Handlebars by preferring the block param", () => {
    const root = { users: [{ name: "Ada", user: "field" }] };
    const user = root.users[0];
    const scope = pushScope(createScope({ context: root }), {
      context: user,
      blockParams: { names: ["user"], values: [user] },
    });

    expect(resolve(scope, "{{user.name}}")).toBe(
      Handlebars.compile("{{#each users as |user|}}{{user.name}}{{/each}}")(root),
    );
  });
});

describe("resolvePath: @data paths", () => {
  const createEachData = () => {
    const root = createFrame();
    root.root = { title: "Title" };
    const frame = createFrame(root);
    frame.index = 2;
    frame.key = "k";
    frame.first = false;
    return { root, frame };
  };

  test("given @index, @key, and @root, should read from the current data frame", () => {
    const { frame } = createEachData();
    const scope = createScope({ context: {}, data: frame });

    expect(resolve(scope, "{{@index}}")).toBe(2);
    expect(resolve(scope, "{{@key}}")).toBe("k");
    expect(resolve(scope, "{{@first}}")).toBe(false);
    expect(resolve(scope, "{{@root.title}}")).toBe("Title");
    expect(resolve(scope, "{{@missing}}")).toBeUndefined();
  });

  test("given @../, should read from the parent data frame regardless of the context chain", () => {
    const { root, frame } = createEachData();
    root.index = 9;
    const scope = pushScope(createScope({ context: {}, data: root }), { context: {}, data: frame });

    expect(resolve(scope, "{{@../index}}")).toBe(9);
    expect(resolve(scope, "{{@../../index}}")).toBeUndefined();
  });

  test("given data tracking disabled, should resolve every @data path to undefined", () => {
    const scope = createScope({ context: { index: 1 } });

    expect(resolve(scope, "{{@index}}")).toBeUndefined();
    expect(resolve(scope, "{{@root.index}}")).toBeUndefined();
  });

  test("given a falsy non-nullish data value with trailing segments, should stop at the falsy value like Handlebars", () => {
    const frame = createFrame();
    frame.index = 0;
    const scope = createScope({ context: {}, data: frame });

    expect(resolve(scope, "{{@index.toFixed}}")).toBe(0);
  });
});

describe("resolvePath: compat mode", () => {
  test("given a miss on the current context, should fall back to ancestors like Mustache", () => {
    const root = { name: "root", child: { other: 1 } };
    const scope = pushScope(createScope({ context: root }), { context: root.child });

    expect(resolve(scope, "{{name}}", { compat: true })).toBe(
      Handlebars.compile("{{#with child}}{{name}}{{/with}}", { compat: true })(root),
    );
    expect(resolve(scope, "{{name}}")).toBeUndefined();
  });

  test("given a scoped path, should not fall back even in compat mode", () => {
    const root = { name: "root", child: {} };
    const scope = pushScope(createScope({ context: root }), { context: root.child });

    expect(resolve(scope, "{{this.name}}", { compat: true })).toBeUndefined();
    expect(resolve(scope, "{{./name}}", { compat: true })).toBeUndefined();
  });

  test("given a hit on the current context, should prefer it over an ancestor", () => {
    const root = { name: "root", child: { name: "child" } };
    const scope = pushScope(createScope({ context: root }), { context: root.child });

    expect(resolve(scope, "{{name}}", { compat: true })).toBe("child");
  });

  test("given a block param, should resolve it without consulting ancestors", () => {
    const scope = pushScope(createScope({ context: { x: "ctx" } }), {
      context: {},
      blockParams: { names: ["x"], values: ["param"] },
    });

    expect(resolve(scope, "{{x}}", { compat: true })).toBe("param");
  });
});

describe("resolvePath: strict mode", () => {
  const expectMissing = (fn: () => unknown, name: string) => {
    let caught: unknown;
    try {
      fn();
    } catch (error) {
      caught = error;
    }
    expect(isRuntimeError(caught)).toBe(true);
    if (!isRuntimeError(caught)) return;
    expect(caught.code).toBe("missing-property");
    expect(caught.message).toContain(`"${name}" not defined in`);
  };

  test("given a present path, should resolve it normally", () => {
    const scope = createScope({ context: { a: { b: 0 } } });

    expect(resolve(scope, "{{a.b}}", { strict: true })).toBe(0);
    expect(resolve(scope, "{{this}}", { strict: true })).toEqual({ a: { b: 0 } });
  });

  test("given a missing final segment, should throw a runtime error naming it as Handlebars does", () => {
    const scope = createScope({ context: { a: {} } });

    expectMissing(() => resolve(scope, "{{missing}}", { strict: true }), "missing");
    expectMissing(() => resolve(scope, "{{a.missing}}", { strict: true }), "missing");
    expect(() => Handlebars.compile("{{a.missing}}", { strict: true })({ a: {} })).toThrow(
      '"missing" not defined in',
    );
  });

  test("given a missing intermediate segment, should throw instead of crashing on undefined", () => {
    const scope = createScope({ context: {} });

    expectMissing(() => resolve(scope, "{{a.b.c}}", { strict: true }), "b");
  });

  test("given a present key holding undefined, should not throw because the key exists", () => {
    const scope = createScope({ context: { a: undefined } });

    expect(resolve(scope, "{{a}}", { strict: true })).toBeUndefined();
    expect(() => Handlebars.compile("{{a}}", { strict: true })({ a: undefined })).not.toThrow();
  });

  test("given an optional path such as a helper parameter, should return undefined for a missing final segment", () => {
    const scope = createScope({ context: { a: {} } });
    const echo = (value: unknown) => String(value);

    expect(resolve(scope, "{{missing}}", { strict: true, optional: true })).toBeUndefined();
    expect(resolve(scope, "{{a.missing}}", { strict: true, optional: true })).toBeUndefined();
    expect(Handlebars.compile("{{echo a.missing}}", { strict: true })({ a: {} }, { helpers: { echo } })).toBe(
      "undefined",
    );
  });

  test("given a missing @data name, should throw like Handlebars", () => {
    const scope = createScope({ context: {}, data: createFrame() });

    expectMissing(() => resolve(scope, "{{@index}}", { strict: true }), "index");
    expect(() => Handlebars.compile("{{@index}}", { strict: true })({})).toThrow('"index" not defined');
  });

  test("given ../ past the top of the chain, should throw because the parent is undefined", () => {
    const scope = createScope({ context: { name: "x" } });

    expectMissing(() => resolve(scope, "{{../name}}", { strict: true }), "name");
  });
});
