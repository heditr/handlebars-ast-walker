import { describe, expect, expectTypeOf, test } from "vitest";
import { parse, parseWithoutProcessing } from "@handlebars/parser";

import type {
  BlockStatement,
  ContentStatement,
  HelperDelegate,
  HelperOptions,
  MustacheStatement,
  ParserProgram,
  Program,
  Statement,
  TemplateDelegate,
} from "../src/types";

/**
 * These tests pin the structural contract between our AST types and the
 * output of `@handlebars/parser`. The assignments below are checked by
 * `tsc`; the runtime assertions only confirm the shape the types describe.
 */
describe("types: parser compatibility", () => {
  test("given an unprocessed parser program, should be accepted as a ParserProgram without casting", () => {
    const parsed = parseWithoutProcessing(
      '{{#each items as |item i|}}{{> (lookup . "p") item x=1}}{{else}}none{{/each}}',
    );
    const input: ParserProgram = parsed;

    expectTypeOf(parsed).toMatchTypeOf<ParserProgram>();
    expect(input.type).toBe("Program");
    expect(input.body).toHaveLength(1);
  });

  test("given a processed parser program, should also be accepted as a ParserProgram", () => {
    const processed = parse("  {{> p}}\n");
    const input: ParserProgram = processed;

    expect(input.body.map(({ type }) => type)).toEqual([
      "ContentStatement",
      "PartialStatement",
      "ContentStatement",
    ]);
  });

  test("given our strict Program, should be assignable to the loose ParserProgram input", () => {
    expectTypeOf<Program>().toMatchTypeOf<ParserProgram>();
  });

  test("given a hand-built AST, should type-check without source locations", () => {
    const content: ContentStatement = {
      type: "ContentStatement",
      value: "Hello ",
      original: "Hello ",
    };
    const mustache: MustacheStatement = {
      type: "MustacheStatement",
      path: {
        type: "PathExpression",
        data: false,
        depth: 0,
        parts: ["name"],
        original: "name",
      },
      params: [],
      escaped: true,
      strip: { open: false, close: false },
    };
    const program: Program = { type: "Program", body: [content, mustache] };

    expect(program.body).toHaveLength(2);
  });

  test("given an inverse-only block, should allow the program to be absent while inverse is present", () => {
    const block: BlockStatement = {
      type: "BlockStatement",
      path: { type: "PathExpression", data: false, depth: 0, parts: ["foo"], original: "foo" },
      params: [],
      inverse: { type: "Program", body: [] },
      openStrip: { open: false, close: false },
      closeStrip: { open: false, close: false },
    };

    expect(block.program).toBeUndefined();
  });

  test("given a Statement union, should narrow by its type discriminant", () => {
    const describeStatement = (node: Statement): string => {
      switch (node.type) {
        case "ContentStatement":
          return node.value;
        case "MustacheStatement":
          return node.escaped ? "escaped" : "raw";
        default:
          return node.type;
      }
    };

    expect(
      describeStatement({ type: "ContentStatement", value: "v", original: "v" }),
    ).toBe("v");
  });
});

describe("types: runtime contracts", () => {
  test("given a helper written with narrow parameter types, should be assignable to HelperDelegate", () => {
    const upper = (value: string, options: HelperOptions): string =>
      `${options.name}:${value.toUpperCase()}`;
    const block = function (this: { title: string }, options: HelperOptions): string {
      return options.fn(this);
    };

    expectTypeOf(upper).toMatchTypeOf<HelperDelegate>();
    expectTypeOf(block).toMatchTypeOf<HelperDelegate>();
  });

  test("given a template delegate, should render a string from a context and optional runtime options", () => {
    const render: TemplateDelegate<{ name: string }> = (context) => context?.name ?? "";

    expect(render({ name: "Ada" })).toBe("Ada");
    expect(render({ name: "Ada" }, { noEscape: true })).toBe("Ada");
  });
});
