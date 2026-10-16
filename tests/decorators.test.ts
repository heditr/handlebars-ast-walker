import { describe, expect, test } from "vitest";

import { createBuiltinDecorators, inlineDecorator } from "../src/decorators";
import type { BlockRenderer, DecoratorContainer, DecoratorOptions, PartialMap } from "../src/types";

const createContainer = (partials: PartialMap = {}): DecoratorContainer => ({
  helpers: {},
  partials,
  decorators: {},
});

const createOptions = (name: string, fn: BlockRenderer): DecoratorOptions => ({
  name: "inline",
  args: [name],
  hash: {},
  fn,
});

/** A program renderer that reports which partials are visible while it runs. */
const listPartials =
  (container: DecoratorContainer): BlockRenderer =>
  () =>
    Object.keys(container.partials).sort().join(",");

describe("inlineDecorator", () => {
  test("given one inline declaration, should expose it as a partial only while the program renders", () => {
    const registered = { outer: "outer" };
    const container = createContainer(registered);
    const props: Record<string, unknown> = {};
    const body: BlockRenderer = () => "body";

    const wrapped = inlineDecorator(listPartials(container), props, container, createOptions("row", body)) as BlockRenderer;

    expect(wrapped()).toBe("outer,row");
    expect(container.partials).toBe(registered);
    expect(registered).toEqual({ outer: "outer" });
  });

  test("given several declarations on one program, should wrap once and collect every body", () => {
    const container = createContainer();
    const props: Record<string, unknown> = {};
    const first: BlockRenderer = () => "a";
    const second: BlockRenderer = () => "b";

    const once = inlineDecorator(listPartials(container), props, container, createOptions("a", first)) as BlockRenderer;
    const twice = inlineDecorator(once, props, container, createOptions("b", second));

    expect(twice).toBe(once);
    expect(once()).toBe("a,b");
    expect(props.partials).toEqual({ a: first, b: second });
  });

  test("given a body that throws, should still restore the original partials", () => {
    const registered = {};
    const container = createContainer(registered);
    const failing: BlockRenderer = () => {
      throw new Error("boom");
    };

    const wrapped = inlineDecorator(failing, {}, container, createOptions("x", () => "")) as BlockRenderer;

    expect(() => wrapped()).toThrow("boom");
    expect(container.partials).toBe(registered);
  });
});

describe("createBuiltinDecorators", () => {
  test("given two calls, should return independent registries containing inline", () => {
    const a = createBuiltinDecorators();
    const b = createBuiltinDecorators();

    expect(a.inline).toBe(inlineDecorator);
    expect(a).not.toBe(b);
  });
});
