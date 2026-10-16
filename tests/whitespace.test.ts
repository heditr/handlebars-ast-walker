import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";
import { parseWithoutProcessing } from "@handlebars/parser";

import { processWhitespace } from "../src/whitespace";
import type { ContentStatement, ParserProgram, PartialStatement, Program } from "../src/types";

/** Loose node shape shared by our AST and the one `Handlebars.parse` returns. */
interface LooseNode {
  type: string;
  value?: unknown;
  indent?: unknown;
  body?: LooseNode[];
  program?: LooseNode;
  inverse?: LooseNode;
}

/**
 * Flattens every piece of whitespace-relevant state in document order so
 * two ASTs can be compared without caring about node identity or locations.
 */
const snapshot = (node: LooseNode | undefined, out: string[] = []): string[] => {
  if (!node) return out;
  if (node.type === "ContentStatement") out.push(`content:${JSON.stringify(node.value)}`);
  if (node.type === "PartialStatement") out.push(`indent:${JSON.stringify(node.indent)}`);
  node.body?.forEach((child) => snapshot(child, out));
  snapshot(node.program, out);
  snapshot(node.inverse, out);
  return out;
};

/** Runs our pass on an unprocessed AST and the 4.7 visitor on the same source. */
const expectParity = (template: string, options: { ignoreStandalone?: boolean } = {}) => {
  const ours = processWhitespace(parseWithoutProcessing(template), options);
  const theirs = Handlebars.parse(template, options) as unknown as LooseNode;

  expect(snapshot(ours as unknown as LooseNode)).toEqual(snapshot(theirs));
};

const process = (template: string, options?: { ignoreStandalone?: boolean }): Program =>
  processWhitespace(parseWithoutProcessing(template), options) as unknown as Program;

const contentAt = (program: Program, index: number): ContentStatement =>
  program.body[index] as ContentStatement;

describe("processWhitespace: tilde control", () => {
  test("given {{~ and ~}} on a mustache, should remove all adjacent whitespace up to the next non-whitespace character", () => {
    const program = process(" a \n\t {{~foo~}} \n b ");

    expect(contentAt(program, 0).value).toBe(" a");
    expect(contentAt(program, 2).value).toBe("b ");
  });

  test("given stripped content, should leave original untouched and flag the stripped side", () => {
    const program = process("  {{~foo}}  ");

    expect(contentAt(program, 0)).toMatchObject({ value: "", original: "  ", leftStripped: true });
    expect(contentAt(program, 2)).toMatchObject({ value: "  ", original: "  " });
    expect(contentAt(program, 2).rightStripped).toBeFalsy();
  });

  test("given tildes on block tags, should strip inside and outside the block like Handlebars 4.7", () => {
    expectParity(" {{~#if a~}} x {{~else~}} y {{~/if~}} ");
    expectParity(" {{~^if a~}} x {{~/if~}} ");
    expectParity("a\n {{~#> layout~}}\n body \n{{~/layout~}}\n z");
    expectParity(" {{~! comment ~}} \n{{~> partial ~}} ");
  });

  test("given a tilde on only one side, should leave the other side intact", () => {
    expectParity("  {{foo~}}  bar");
    expectParity("  {{~foo}}  bar");
    expectParity("{{#if a}}\n  x\n  {{~/if}}  ");
  });
});

describe("processWhitespace: return value and idempotence", () => {
  test("given a program, should return the same object so callers can chain", () => {
    const input: ParserProgram = parseWithoutProcessing("{{~a~}}");

    expect(processWhitespace(input)).toBe(input);
  });

  test("given a program already processed by this pass, should not strip it a second time", () => {
    const program = process("{{#if a}}\n  x\n{{/if}}\n");
    const once = snapshot(program as unknown as LooseNode);

    processWhitespace(program);

    expect(snapshot(program as unknown as LooseNode)).toEqual(once);
  });

  test("given two separate parses of the same source, should process each independently", () => {
    const first = process(" {{~a}}");
    const second = process(" {{~a}}");

    expect(contentAt(first, 0).value).toBe("");
    expect(contentAt(second, 0).value).toBe("");
  });
});

describe("processWhitespace: standalone lines", () => {
  test("given a block whose open and close tags each sit alone on a line, should remove those lines entirely", () => {
    expectParity("before\n  {{#if a}}\n  content\n  {{/if}}\nafter\n");
    expectParity("{{#each items}}\n  {{this}}\n{{/each}}\n");
  });

  test("given a standalone else, should remove its line in both the program and the inverse", () => {
    expectParity("{{#if a}}\n  yes\n  {{else}}\n  no\n{{/if}}\n");
    expectParity("{{#if a}}\n  yes\n{{^}}\n  no\n{{/if}}\n");
  });

  test("given a standalone tag at the very start or end of the template, should treat the file edge as a line break", () => {
    expectParity("  {{#if a}}\n  x\n  {{/if}}");
    expectParity("{{! only a comment }}");
    expectParity("  {{> partial}}");
    expectParity("{{> partial}}  ");
  });

  test("given a standalone comment, should remove the comment's line", () => {
    expectParity("a\n  {{! note }}  \nb\n");
    expectParity("a\n  {{!-- note --}}\nb\n");
    expectParity("a {{! inline }} b\n");
  });

  test("given a mustache alone on a line, should keep the line since mustaches are never standalone", () => {
    expectParity("a\n  {{foo}}\nb\n");
  });

  test("given a standalone decorator or decorator block, should remove its lines", () => {
    expectParity("a\n  {{*dec}}\nb\n");
    expectParity("a\n{{#*inline \"name\"}}\n  body\n{{/inline}}\nb\n");
  });

  test("given a standalone partial block, should remove its open and close lines", () => {
    expectParity("a\n  {{#> layout}}\n  body\n  {{/layout}}\nb\n");
  });

  test("given windows line endings, should recognise standalone lines", () => {
    expectParity("a\r\n  {{#if a}}\r\n  x\r\n  {{/if}}\r\nb\r\n");
    expectParity("a\r\n  {{> p}}\r\nb\r\n");
  });

  test("given ignoreStandalone, should keep standalone lines but still honour tildes", () => {
    expectParity("a\n  {{#if a}}\n  x\n  {{/if}}\nb\n", { ignoreStandalone: true });
    expectParity("a\n  {{~> p}}\n  {{! c }}\nb\n", { ignoreStandalone: true });
    expectParity("{{#if a}}\n  yes\n  {{else}}\n  no\n{{/if}}\n", { ignoreStandalone: true });
  });
});

describe("processWhitespace: partial indent", () => {
  test("given a standalone partial on an indented line, should record the indent and clear it from the content", () => {
    const program = process("<ul>\n  {{> item}}\n</ul>");

    expect((program.body[1] as PartialStatement).indent).toBe("  ");
    expect(contentAt(program, 0).value).toBe("<ul>\n");
    expectParity("<ul>\n  {{> item}}\n</ul>");
  });

  test("given an inline partial or one with a left tilde, should leave indent empty", () => {
    expectParity("a {{> item}}\n");
    expectParity("a\n  {{~> item}}\n");
    expectParity("<ul>\n\t{{> item}}\n</ul>");
  });
});

describe("processWhitespace: chained else", () => {
  test("given standalone else if chains, should strip like Handlebars 4.7 at every link", () => {
    expectParity("{{#if a}}\n  a\n{{else if b}}\n  b\n{{else if c}}\n  c\n{{else}}\n  d\n{{/if}}\n");
    expectParity("x\n  {{#if a}}\n  a\n  {{else if b}}\n  b\n  {{/if}}\ny\n");
  });

  test("given tildes inside a chain, should apply them to the right program bodies", () => {
    expectParity("{{#if a~}} a {{~else if b~}} b {{~else~}} c {{~/if}}");
    expectParity("{{#if a}} a {{else if b~}} b {{/if~}} z");
  });

  test("given an indented close tag after a chain, should keep that indent as Handlebars 4.7 does", () => {
    // 4.7's closeStandalone calls omitLeft on the chained inverse program, whose last
    // statement is the nested block rather than content, so the indent survives.
    const program = process("{{#if a}}\n  a\n{{else if b}}\n  b\n  {{/if}}\n");
    const inner = (program.body[0] as { inverse: Program }).inverse.body[0] as {
      program: Program;
    };

    expect(contentAt(inner.program, 0).value).toBe("  b\n  ");
    expectParity("{{#if a}}\n  a\n{{else if b}}\n  b\n  {{/if}}\n");
  });
});

describe("processWhitespace: edge cases", () => {
  test("given adjacent standalone tags, should not double-strip shared whitespace", () => {
    expectParity("{{#if a}}\n{{#if b}}\n  x\n{{/if}}\n{{/if}}\n");
    expectParity("{{! a }}\n{{! b }}\n");
    expectParity("{{> a}}\n{{> b}}\n");
  });

  test("given blocks with empty bodies, should not throw and should match Handlebars 4.7", () => {
    expectParity("{{#if a}}{{/if}}");
    expectParity("{{#if a}}{{else}}{{/if}}");
    expectParity("a\n  {{#if a}}{{/if}}\nb");
    expectParity("{{~#if a~}}{{~/if~}}");
  });

  test("given whitespace-only content between tags, should match Handlebars 4.7", () => {
    expectParity("{{a}} \n {{b}}");
    expectParity("{{#if a}} \n {{/if}}");
    expectParity(" \n {{#if a}} \n {{/if}} \n ");
    expectParity("\n\n{{! c }}\n\n");
  });

  test("given long whitespace runs, should finish quickly", () => {
    const run = " ".repeat(50_000);
    const started = performance.now();

    expectParity(`${run}{{~a~}}${run}\n${run}{{#if b}}\n${run}\n${run}{{/if}}\n`);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
