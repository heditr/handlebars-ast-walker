import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";
import { parseWithoutProcessing } from "@handlebars/parser";

import { isRuntimeError } from "../src/errors";
import { SafeString } from "../src/escape";
import type { BlockOptions } from "../src/types";
import { evaluateProgram, type EvaluateOptions } from "../src/walker";

// ---------------------------------------------------------------------------
// Harness: render with the walker and with Handlebars 4.7.10 from one option bag
// ---------------------------------------------------------------------------

type HandlebarsRuntime = Parameters<ReturnType<typeof Handlebars.compile>>[1];

/**
 * Handlebars splits options between `compile` and the template call; the
 * walker takes one bag. The split is reproduced here so a single options
 * object drives both engines.
 */
const splitOptions = (options: EvaluateOptions) => {
  const { helpers, partials, decorators, data, allowProtoPropertiesByDefault, allowProtoMethodsByDefault, allowedProtoProperties, allowedProtoMethods, ...compile } = options;
  const runtime: Record<string, unknown> = { helpers, partials, decorators, allowProtoPropertiesByDefault, allowProtoMethodsByDefault, allowedProtoProperties, allowedProtoMethods };
  if (typeof data === "object") runtime.data = data;
  return {
    compile: typeof data === "boolean" ? { ...compile, data } : compile,
    runtime: runtime as HandlebarsRuntime,
  };
};

const render = (template: string, context?: unknown, options: EvaluateOptions = {}): string =>
  evaluateProgram(parseWithoutProcessing(template), context, options);

const renderWithHandlebars = (template: string, context?: unknown, options: EvaluateOptions = {}): string => {
  const { compile, runtime } = splitOptions(options);
  return Handlebars.compile(template, compile as never)(context, runtime);
};

/** Asserts the walker and Handlebars 4.7.10 produce the same output, and returns it. */
const expectParity = (template: string, context?: unknown, options: EvaluateOptions = {}): string => {
  const actual = render(template, context, options);
  expect(actual).toBe(renderWithHandlebars(template, context, options));
  return actual;
};

const expectRuntimeError = (fn: () => unknown, code: string, message: string): void => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isRuntimeError(caught)).toBe(true);
  if (!isRuntimeError(caught)) return;
  expect(caught.code).toBe(code);
  expect(caught.message).toContain(message);
};

// ---------------------------------------------------------------------------
// Content and mustaches
// ---------------------------------------------------------------------------

describe("evaluateProgram: content and comments", () => {
  test("given plain text, should emit it unchanged", () => {
    expect(expectParity("Hello, world!\n<b>x</b>")).toBe("Hello, world!\n<b>x</b>");
  });

  test("given comments, should emit nothing for them", () => {
    expect(expectParity("a{{! one }}b{{!-- two --}}c")).toBe("abc");
  });

  test("given an unprocessed AST, should apply whitespace control before rendering", () => {
    expect(expectParity("  {{#if true}}\n  x\n  {{/if}}\n", {})).toBe("  x\n");
  });

  test("given processWhitespace false, should render the AST as-is", () => {
    expect(render("  {{~x~}}  ", { x: 1 }, { processWhitespace: false })).toBe("  1  ");
  });
});

describe("evaluateProgram: mustaches", () => {
  test("given {{expr}}, should HTML-escape the value", () => {
    expect(expectParity("{{v}}", { v: `<a href="x">'&'</a>` })).toBe(
      "&lt;a href&#x3D;&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;",
    );
  });

  test("given {{{expr}}} or {{& expr}}, should emit the raw value", () => {
    expect(expectParity("{{{v}}}|{{& v}}", { v: "<b>" })).toBe("<b>|<b>");
  });

  test("given a SafeString, should emit it without escaping", () => {
    expect(render("{{v}}", { v: new SafeString("<b>") })).toBe("<b>");
    expect(renderWithHandlebars("{{v}}", { v: new Handlebars.SafeString("<b>") })).toBe("<b>");
  });

  test("given noEscape, should skip escaping everywhere", () => {
    expect(expectParity("{{v}}", { v: "<" }, { noEscape: true })).toBe("<");
  });

  test("given null, undefined, or a missing property, should emit an empty string", () => {
    expect(expectParity("[{{a}}][{{b}}][{{c}}]", { a: null, b: undefined })).toBe("[][][]");
  });

  test("given zero or false, should emit them rather than treating them as empty", () => {
    expect(expectParity("{{a}}{{b}}", { a: 0, b: false })).toBe("0false");
  });

  test("given a literal in mustache position, should treat it as a path", () => {
    expect(
      expectParity('{{"foo"}} {{undefined}} {{null}} {{0}} {{true}}', {
        foo: "F",
        undefined: "U",
        null: "N",
        0: "Z",
        true: "T",
      }),
    ).toBe("F U N Z T");
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("evaluateProgram: path resolution", () => {
  test("given dotted and segment-literal paths, should walk nested objects", () => {
    expect(expectParity("{{a.b.c}} {{a.[b].c}} {{a/b/c}}", { a: { b: { c: "deep" } } })).toBe(
      "deep deep deep",
    );
  });

  test("given this, ., and ./, should refer to the current context", () => {
    expect(expectParity("{{this}}|{{.}}|{{./x}}|{{this.x}}", { x: 1, toString: () => "ctx" })).toBe(
      "ctx|ctx|1|1",
    );
  });

  test("given ../, should read the parent context and ../../ the grandparent", () => {
    const context = { name: "root", a: { name: "a", b: { name: "b" } } };
    expect(expectParity("{{#with a}}{{#with b}}{{name}} {{../name}} {{../../name}}{{/with}}{{/with}}", context)).toBe(
      "b a root",
    );
  });

  test("given a null in the middle of a path, should yield an empty string", () => {
    expect(expectParity("[{{a.b.c}}]", { a: null })).toBe("[]");
  });

  test("given a function on the context, should call it with the context as this and options as the argument", () => {
    const context = {
      label: "ctx",
      shout(this: { label: string }, options: { name: string; hash: object }) {
        return `${this.label}:${options.name}:${JSON.stringify(options.hash)}`;
      },
    };
    expect(expectParity("{{shout}}", context)).toBe("ctx:shout:{}");
  });

  test("given a context function with arguments, should pass them before the options", () => {
    const context = { sum: (a: number, b: number, options: { name: string }) => `${a + b}:${options.name}` };
    expect(expectParity("{{sum 1 2}}", context)).toBe("3:sum");
  });

  test("given @root, should read the root context from anywhere", () => {
    expect(expectParity("{{#with a}}{{@root.name}}{{/with}}", { name: "r", a: {} })).toBe("r");
  });

  test("given a missing ambiguous name, should resolve to nothing rather than throw", () => {
    expect(expectParity("[{{nothing}}]", {})).toBe("[]");
  });

  test("given a helper-shaped call to an unknown name, should throw a missing-helper error", () => {
    expectRuntimeError(() => render("{{nothing 1}}", {}), "missing-helper", 'Missing helper: "nothing"');
    expect(() => renderWithHandlebars("{{nothing 1}}", {})).toThrow('Missing helper: "nothing"');
  });

  test("given a dotted path with arguments whose target is not a function, should throw a missing-helper error", () => {
    expectRuntimeError(() => render("{{a.b 5}}", { a: { b: 0 } }), "missing-helper", 'Missing helper: "a.b"');
  });

  test("given a dotted path with arguments whose target is a function, should call it", () => {
    const context = { a: { b: (x: number, options: { name: string }) => `${x}${options.name}` } };
    expect(expectParity("{{a.b 5}}", context)).toBe("5a.b");
  });

  test("given a helper and a context property of the same name, should prefer the helper", () => {
    expect(expectParity("{{foo}}", { foo: "ctx" }, { helpers: { foo: () => "helper" } })).toBe("helper");
  });

  test("given a helper with no arguments, should call it with the context as this", () => {
    const helpers = { me(this: { n: number }) { return this.n; } };
    expect(expectParity("{{me}}", { n: 7 }, { helpers })).toBe("7");
  });

  test("given a null context, should call helpers with a sealed empty object as this", () => {
    const helpers = { probe(this: object) { return `${Object.isSealed(this)}:${JSON.stringify(this)}`; } };
    expect(expectParity("{{probe}}", null, { helpers })).toBe("true:{}");
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describe("evaluateProgram: built-in block helpers", () => {
  test("given #if / #unless with else, should pick the branch Handlebars picks", () => {
    const template = "{{#if a}}A{{else}}notA{{/if}}|{{#unless b}}notB{{else}}B{{/unless}}";
    expect(expectParity(template, { a: 0, b: [1] })).toBe("notA|B");
    expect(expectParity(template, { a: "x", b: [] })).toBe("A|notB");
  });

  test("given #if includeZero=true, should treat zero as truthy", () => {
    expect(expectParity("{{#if n includeZero=true}}zero{{/if}}", { n: 0 })).toBe("zero");
  });

  test("given chained else-if, should render the first matching branch", () => {
    const template = "{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}";
    expect(expectParity(template, { b: true })).toBe("B");
    expect(expectParity(template, { c: true })).toBe("C");
    expect(expectParity(template, {})).toBe("D");
  });

  test("given #each over an array, should expose @index, @first, @last, and the item as this", () => {
    const template = "{{#each items}}{{@index}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}}:{{this}} {{/each}}";
    expect(expectParity(template, { items: ["a", "b", "c"] })).toBe("0F:a 1:b 2L:c ");
  });

  test("given #each over an object, should expose @key", () => {
    expect(expectParity("{{#each o}}{{@key}}={{this}};{{/each}}", { o: { x: 1, y: 2 } })).toBe("x=1;y=2;");
  });

  test("given #each with block params, should bind value and key by name", () => {
    expect(expectParity("{{#each items as |item i|}}{{i}}:{{item.n}} {{/each}}", { items: [{ n: "a" }, { n: "b" }] })).toBe(
      "0:a 1:b ",
    );
  });

  test("given nested #each, should resolve ../ and @../index across iterations", () => {
    const template = "{{#each rows}}{{#each this}}{{@../index}}.{{@index}}={{this}}{{#unless @last}},{{/unless}}{{/each}};{{/each}}";
    expect(expectParity(template, { rows: [[1, 2], [3]] })).toBe("0.0=1,0.1=2;1.0=3;");
  });

  test("given #each over an empty collection, should render the else branch", () => {
    expect(expectParity("{{#each items}}x{{else}}none{{/each}}", { items: [] })).toBe("none");
  });

  test("given #with, should switch context and keep ../ pointing at the caller", () => {
    expect(expectParity("{{#with a}}{{n}}{{../n}}{{/with}}", { n: 0, a: { n: 1 } })).toBe("10");
  });

  test("given #with block params, should alias the context", () => {
    expect(expectParity("{{#with a as |it|}}{{it.n}}{{/with}}", { a: { n: 1 } })).toBe("1");
  });

  test("given lookup, should read dynamic keys through secure property access", () => {
    expect(expectParity("{{lookup o k}}|{{lookup o 'constructor'}}", { o: { a: "A" }, k: "a" })).toBe("A|");
  });

  test("given a block parameter shadowing a helper name, should resolve the block parameter", () => {
    expect(expectParity("{{#each items as |lookup|}}{{lookup}}{{/each}}", { items: ["bp"] })).toBe("bp");
  });

  test("given data tracking disabled, should render @data variables as empty and pass helpers no frame", () => {
    // Handlebars itself re-enables data the moment a template mentions `@index`;
    // the walker honours `data: false` literally, as documented on RuntimeOptions.
    const helpers = { probe: (options: { data: unknown }) => String(options.data) };
    expect(render("{{#each items}}[{{@index}}]{{/each}}{{probe}}", { items: ["a"] }, { data: false, helpers })).toBe(
      "[]undefined",
    );
  });

  test("given a seeded data frame, should expose it as @data and still set @root", () => {
    expect(expectParity("{{@env}}:{{@root.n}}", { n: 1 }, { data: { env: "prod" } })).toBe("prod:1");
  });
});

describe("evaluateProgram: custom block helpers and blockHelperMissing", () => {
  test("given a block helper, should pass fn and inverse that render in the block's scope", () => {
    const helpers = {
      twice: (options: { fn: (ctx: unknown) => string; inverse: (ctx: unknown) => string }) =>
        options.fn({ n: 1 }) + options.fn({ n: 2 }) + options.inverse({ n: 3 }),
    };
    expect(expectParity("{{#twice}}[{{n}}]{{else}}({{n}}){{/twice}}", {}, { helpers })).toBe("[1][2](3)");
  });

  test("given fn called with a data frame, should expose it to the block body", () => {
    const helpers = {
      framed: (options: { fn: (ctx: unknown, o: { data: unknown }) => string; data: Record<string, unknown> }) =>
        options.fn({}, { data: { ...options.data, tag: "T" } }),
    };
    expect(expectParity("{{#framed}}{{@tag}}{{@root.n}}{{/framed}}", { n: 1 }, { helpers })).toBe("T1");
  });

  test("given fn called with blockParams, should bind the declared names", () => {
    const helpers = {
      pair: (options: { fn: (ctx: unknown, o: { blockParams: unknown[] }) => string }) =>
        options.fn({}, { blockParams: ["one", "two"] }),
    };
    expect(expectParity("{{#pair as |a b|}}{{a}}{{b}}{{/pair}}", {}, { helpers })).toBe("onetwo");
  });

  test("given a helper returning a value for a mustache, should emit it escaped; for a block, raw", () => {
    const helpers = { tag: () => "<i>" };
    expect(expectParity("{{tag}}|{{#tag}}{{/tag}}", {}, { helpers })).toBe("&lt;i&gt;|<i>");
  });

  test("given {{#name}} over a truthy non-array value, should use it as the block context", () => {
    expect(expectParity("{{#person}}{{name}}{{/person}}", { person: { name: "Ada" } })).toBe("Ada");
  });

  test("given {{#name}} over an array, should iterate like #each", () => {
    expect(expectParity("{{#items}}{{this}}{{@index}}{{/items}}", { items: ["a", "b"] })).toBe("a0b1");
  });

  test("given {{#name}} over false, undefined, or an empty array, should render the inverse", () => {
    expect(expectParity("{{#a}}A{{else}}!A{{/a}}{{#b}}B{{else}}!B{{/b}}{{#c}}C{{else}}!C{{/c}}", { a: false, c: [] })).toBe(
      "!A!B!C",
    );
  });

  test("given {{^name}}, should render only when the value is falsy", () => {
    expect(expectParity("{{^a}}noA{{/a}}{{^b}}noB{{/b}}", { a: false, b: 1 })).toBe("noA");
  });

  test("given {{#name}} where name is a context function, should call it and section over the result", () => {
    expect(expectParity("{{#foo}}[{{this}}]{{/foo}}", { foo: () => "val" })).toBe("[val]");
  });

  test("given {{#this.name}} or {{#../name}}, should section over the property without helper lookup", () => {
    const options = { helpers: { items: () => "helper" } };
    expect(expectParity("{{#this.items}}{{this}}{{/this.items}}", { items: ["x"] }, options)).toBe("x");
  });

  test("given a helper-shaped block call to an unregistered name, should throw missing-helper", () => {
    expectRuntimeError(() => render("{{#nope 1}}x{{/nope}}", {}), "missing-helper", 'Missing helper: "nope"');
  });
});

describe("evaluateProgram: strict, compat, and knownHelpersOnly", () => {
  test("given strict mode and a missing property, should throw missing-property with the location", () => {
    expectRuntimeError(() => render("\n{{foo}}", {}, { strict: true }), "missing-property", '"foo" not defined in');
    expect(() => renderWithHandlebars("{{foo}}", {}, { strict: true })).toThrow('"foo" not defined');
  });

  test("given strict mode and a present but null property, should render nothing", () => {
    expect(expectParity("[{{foo}}]", { foo: null }, { strict: true })).toBe("[]");
  });

  test("given strict mode, should not throw for a missing helper argument", () => {
    const helpers = { show: (x: unknown) => String(x) };
    expect(expectParity("{{show a.b}}", { a: {} }, { strict: true, helpers })).toBe("undefined");
  });

  test("given strict mode and a missing block head, should throw rather than call blockHelperMissing", () => {
    expectRuntimeError(() => render("{{#foo}}x{{/foo}}", {}, { strict: true }), "missing-property", '"foo" not defined in');
  });

  test("given compat mode, should fall back to parent contexts for missing names", () => {
    const context = { title: "T", items: [{ n: 1 }] };
    expect(expectParity("{{#each items}}{{n}}{{title}}{{/each}}", context, { compat: true })).toBe("1T");
    expect(expectParity("{{#each items}}{{n}}[{{title}}]{{/each}}", context)).toBe("1[]");
  });

  test("given knownHelpersOnly, should treat unregistered bare names as properties", () => {
    expect(expectParity("{{foo}}", { foo: "x" }, { knownHelpersOnly: true })).toBe("x");
  });

  test("given knownHelpersOnly and a helper-shaped call to an unregistered name, should throw unknown-helper", () => {
    expectRuntimeError(
      () => render("{{foo 1}}", { foo: "x" }, { knownHelpersOnly: true }),
      "unknown-helper",
      "You specified knownHelpersOnly, but used the unknown helper foo",
    );
  });

  test("given knownHelpersOnly, should treat built-in and registered helpers as known", () => {
    // Handlebars only knows compile-time `knownHelpers`; here every registered helper is known.
    const helpers = { up: (s: string) => s.toUpperCase() };
    expect(render("{{#if true}}y{{/if}}{{up 'a'}}", {}, { knownHelpersOnly: true, helpers })).toBe("yA");
  });
});

// ---------------------------------------------------------------------------
// Sub-expressions and hashes
// ---------------------------------------------------------------------------

describe("evaluateProgram: sub-expressions and hashes", () => {
  const helpers = {
    join: (...args: unknown[]) => {
      const options = args.pop() as { hash: Record<string, unknown> };
      const sep = typeof options.hash.sep === "string" ? options.hash.sep : ",";
      return args.join(sep);
    },
    up: (s: unknown) => String(s).toUpperCase(),
    typeOf: (v: unknown) => (v === null ? "null" : typeof v),
  };

  test("given nested sub-expressions, should pass raw inner results to the outer helper", () => {
    expect(expectParity("{{join (up 'a') (join 'b' 'c' sep='-') sep='+'}}", {}, { helpers })).toBe("A+b-c");
  });

  test("given a sub-expression returning HTML, should escape only at the mustache", () => {
    expect(expectParity("{{join (up '<b>')}}|{{{join (up '<b>')}}}", {}, { helpers })).toBe("&lt;B&gt;|<B>");
  });

  test("given every literal type as an argument, should pass the typed value", () => {
    expect(expectParity("{{typeOf 1}} {{typeOf 'x'}} {{typeOf true}} {{typeOf null}} {{typeOf undefined}}", {}, { helpers })).toBe(
      "number string boolean null undefined",
    );
  });

  test("given hash values that are paths and sub-expressions, should evaluate them in the current scope", () => {
    const helpers2 = { ...helpers, show: (options: { hash: Record<string, unknown> }) => JSON.stringify(options.hash) };
    // Key order is reversed because Handlebars assigns hash keys from a stack.
    expect(expectParity("{{#with a}}{{show x=n y=(up n) z=../n}}{{/with}}", { n: "r", a: { n: "a" } }, { helpers: helpers2 })).toBe(
      "{&quot;z&quot;:&quot;r&quot;,&quot;y&quot;:&quot;A&quot;,&quot;x&quot;:&quot;a&quot;}",
    );
  });

  test("given hash values, should evaluate them left to right regardless of assignment order", () => {
    const calls: string[] = [];
    const helpers2 = {
      trace: (tag: string) => { calls.push(tag); return tag; },
      show: (options: { hash: Record<string, unknown> }) => Object.values(options.hash).join(""),
    };
    expect(render("{{show a=(trace 'first') b=(trace 'second')}}", {}, { helpers: helpers2 })).toBe("secondfirst");
    expect(calls).toEqual(["first", "second"]);
  });

  test("given a function argument, should pass it uncalled so the helper decides", () => {
    const fn = () => "called";
    const helpers2 = { kind: (v: unknown) => typeof v };
    expect(expectParity("{{kind f}}", { f: fn }, { helpers: helpers2 })).toBe("function");
  });

  test("given a sub-expression as a block argument, should feed the block helper", () => {
    expect(expectParity("{{#if (join '')}}T{{else}}F{{/if}}{{#if (join 'x')}}T{{else}}F{{/if}}", {}, { helpers })).toBe("FT");
  });

  test("given a bare sub-expression naming nothing, should yield undefined like a missing property", () => {
    expect(expectParity("{{typeOf (nope)}}", {}, { helpers })).toBe("undefined");
  });

  test("given a sub-expression with arguments naming an unknown helper, should throw missing-helper", () => {
    expectRuntimeError(() => render("{{up (nope 1)}}", {}, { helpers }), "missing-helper", 'Missing helper: "nope"');
    expect(() => renderWithHandlebars("{{up (nope 1)}}", {}, { helpers })).toThrow('Missing helper: "nope"');
  });
});

// ---------------------------------------------------------------------------
// Partials
// ---------------------------------------------------------------------------

describe("evaluateProgram: partials", () => {
  const withParser = (options: EvaluateOptions): EvaluateOptions => ({ ...options, parse: parseWithoutProcessing });

  test("given a string partial and a parser, should render it with the current context", () => {
    expect(expectParity("{{> who}}!", { name: "Ada" }, withParser({ partials: { who: "Hi {{name}}" } }))).toBe("Hi Ada!");
  });

  test("given a string partial without a parser, should throw invalid-partial", () => {
    expectRuntimeError(() => render("{{> who}}", {}, { partials: { who: "x" } }), "invalid-partial", "could not be compiled");
  });

  test("given a string partial invoked repeatedly, should parse its source once per render", () => {
    let parses = 0;
    const parse = (source: string) => {
      parses += 1;
      return parseWithoutProcessing(source);
    };
    expect(render("{{#each items}}{{> row}}{{/each}}", { items: [1, 2, 3] }, { parse, partials: { row: "[{{this}}]" } })).toBe("[1][2][3]");
    expect(parses).toBe(1);
  });

  test("given a pre-parsed program partial, should render it without a parser", () => {
    expect(render("{{> who}}", { name: "Ada" }, { partials: { who: parseWithoutProcessing("Hi {{name}}") } })).toBe("Hi Ada");
  });

  test("given a function partial, should call it with the context and data frame", () => {
    const partials = {
      who: (context?: unknown, options?: BlockOptions) => `${JSON.stringify(context)}:${JSON.stringify(options?.data?.root)}`,
    };
    expect(render("{{#with a}}{{> who}}{{/with}}", { a: { n: 1 } }, { partials })).toBe('{"n":1}:{"a":{"n":1}}');
  });

  test("given an explicit context argument, should render the partial with it", () => {
    expect(expectParity("{{> who person}}", { person: { name: "Bo" } }, withParser({ partials: { who: "{{name}}" } }))).toBe("Bo");
  });

  test("given hash arguments, should merge them over the context without mutating it", () => {
    const context = { x: 1, y: 3 };
    expect(expectParity("{{> p x=2}}|{{x}}", context, withParser({ partials: { p: "{{x}}{{y}}" } }))).toBe("23|1");
    expect(context.x).toBe(1);
  });

  test("given more than one argument, should throw invalid-arguments", () => {
    expectRuntimeError(() => render("{{> p a b}}", {}, withParser({ partials: { p: "" } })), "invalid-arguments", "Unsupported number of partial arguments: 2");
  });

  test("given a dynamic partial name, should evaluate the sub-expression to pick the partial", () => {
    expect(expectParity("{{> (lookup . 'which')}}", { which: "b" }, withParser({ partials: { a: "A", b: "B" } }))).toBe("B");
  });

  test("given a dynamic name that resolves to nothing, should throw missing-partial", () => {
    expectRuntimeError(() => render("{{> (lookup . 'which')}}", {}, withParser({ partials: {} })), "missing-partial", "The partial undefined could not be found");
  });

  test("given a missing partial, should throw missing-partial with the name", () => {
    expectRuntimeError(() => render("{{> nope}}", {}), "missing-partial", "The partial nope could not be found");
    expect(() => renderWithHandlebars("{{> nope}}", {})).toThrow("The partial nope could not be found");
  });

  test("given a standalone partial line, should indent every output line except a trailing empty one", () => {
    expect(expectParity("  {{> p}}\nend", {}, withParser({ partials: { p: "a\nb\n" } }))).toBe("  a\n  b\nend");
  });

  test("given preventIndent, should emit the indent once and leave later lines alone", () => {
    expect(expectParity("  {{> p}}\n", {}, withParser({ preventIndent: true, partials: { p: "a\nb\n" } }))).toBe("  a\nb\n");
  });

  test("given ../ inside a partial, should read nothing unless compat keeps the caller's chain", () => {
    const context = { a: { v: 1 }, v: 0 };
    const partials = { p: "[{{../v}}]" };
    expect(expectParity("{{#with a}}{{> p}}{{/with}}", context, withParser({ partials }))).toBe("[]");
    expect(expectParity("{{#with a}}{{> p}}{{/with}}", context, withParser({ partials, compat: true }))).toBe("[0]");
  });

  test("given explicitPartialContext, should render partials with no context unless one is passed", () => {
    const partials = { p: "[{{x}}]" };
    expect(expectParity("{{> p}}{{> p this}}", { x: 1 }, withParser({ explicitPartialContext: true, partials }))).toBe("[][1]");
  });

  test("given block parameters in the caller, should not leak them into the partial", () => {
    const partials = { p: "[{{item}}]" };
    expect(expectParity("{{#each items as |item|}}{{> p}}{{/each}}", { items: ["x"], item: "ctx" }, withParser({ partials }))).toBe("[]");
  });

  test("given a partial block, should expose the body as @partial-block", () => {
    const partials = { layout: "<{{> @partial-block}}>" };
    expect(expectParity("{{#> layout}}body {{n}}{{/layout}}", { n: 1 }, withParser({ partials }))).toBe("<body 1>");
  });

  test("given a missing partial with a partial block, should render the body instead of throwing", () => {
    expect(expectParity("{{#> nope}}fallback {{n}}{{/nope}}", { n: 1 })).toBe("fallback 1");
  });

  test("given nested partial blocks, should resolve @partial-block outward", () => {
    const partials = { a: "[{{#> b}}{{> @partial-block}}{{/b}}]", b: "(b:{{> @partial-block}})" };
    expect(expectParity("{{#> a}}A{{/a}}", {}, withParser({ partials }))).toBe("[(b:A)]");
  });

  test("given @partial-block rendered inside #each, should see the iteration's data", () => {
    const partials = { p: "<{{> @partial-block}}>" };
    expect(expectParity("{{#each items}}{{#> p}}{{@index}}{{/p}}{{/each}}", { items: ["a", "b"] }, withParser({ partials }))).toBe("<0><1>");
  });

  test("given @partial-block outside any partial block, should throw missing-partial", () => {
    expectRuntimeError(() => render("{{> @partial-block}}", {}), "missing-partial", "The partial @partial-block could not be found");
  });

  test("given a partial that uses helpers, should see the render's helpers", () => {
    const helpers = { up: (s: string) => s.toUpperCase() };
    expect(expectParity("{{> p}}", { n: "a" }, withParser({ helpers, partials: { p: "{{up n}}" } }))).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// Decorators and inline partials
// ---------------------------------------------------------------------------

describe("evaluateProgram: decorators", () => {
  test("given an inline partial, should be callable anywhere in the same program, even before its declaration", () => {
    expect(expectParity('{{> p}}|{{#*inline "p"}}inline {{n}}{{/inline}}{{> p}}', { n: 1 })).toBe("inline 1|inline 1");
  });

  test("given an inline partial inside a block, should not be visible outside that block", () => {
    const partials = { p: "outer" };
    expect(expectParity('{{#if true}}{{#*inline "p"}}in{{/inline}}{{> p}}{{/if}}|{{> p}}', {}, { partials, parse: parseWithoutProcessing })).toBe(
      "in|outer",
    );
  });

  test("given an inline partial shadowing a registered one, should prefer the inline body and leave the registry untouched", () => {
    const partials = { p: "outer" };
    expect(expectParity('{{#*inline "p"}}in{{/inline}}{{> p}}', {}, { partials, parse: parseWithoutProcessing })).toBe("in");
    expect(partials).toEqual({ p: "outer" });
  });

  test("given an inline partial declared inside a partial block, should be visible to the layout partial", () => {
    const partials = { layout: "<{{> content}}>" };
    expect(expectParity('{{#> layout}}{{#*inline "content"}}C{{n}}{{/inline}}{{/layout}}', { n: 1 }, { partials, parse: parseWithoutProcessing })).toBe(
      "<C1>",
    );
  });

  test("given a custom decorator, should receive args, hash, name, and be able to replace the renderer", () => {
    const decorators = {
      wrap: (fn: (ctx: unknown) => string, _props: unknown, _container: unknown, options: { args: unknown[]; hash: Record<string, unknown>; name: string }) =>
        (ctx: unknown) => `${options.name}${JSON.stringify(options.args)}${JSON.stringify(options.hash)}{${fn(ctx)}}`,
    };
    expect(expectParity("{{* wrap 'a' k=1}}body", {}, { decorators })).toBe('wrap["a"]{"k":1}{body}');
  });

  test("given a decorator argument path inside a block, should evaluate it where the block is declared", () => {
    const decorators = { show: (_fn: unknown, _p: unknown, _c: unknown, options: { args: unknown[] }) => () => JSON.stringify(options.args) };
    expect(expectParity("{{#with a}}{{* show n}}{{/with}}", { a: { n: 1 }, n: 0 }, { decorators })).toBe("[0]");
  });

  test("given a decorator in a block whose body never renders, should still run it", () => {
    let ran = false;
    const decorators = { mark: () => { ran = true; return undefined; } };
    expect(render("{{#if false}}{{* mark}}{{/if}}", {}, { decorators })).toBe("");
    expect(ran).toBe(true);
  });

  test("given a decorator returning nothing, should keep the original renderer", () => {
    const decorators = { noop: () => undefined };
    expect(expectParity("{{* noop}}kept", {}, { decorators })).toBe("kept");
  });

  test("given an unregistered decorator, should throw missing-decorator", () => {
    expectRuntimeError(() => render("{{* nope}}", {}), "missing-decorator", 'Missing decorator: "nope"');
    expect(() => renderWithHandlebars("{{* nope}}", {})).toThrow('Missing decorator: "nope"');
  });

  test("given a decorator that swaps helpers through the container, should affect the decorated program only", () => {
    const decorators = {
      shout: (fn: (ctx: unknown) => string, _p: unknown, container: { helpers: Record<string, unknown> }) => (ctx: unknown) => {
        const original = container.helpers;
        container.helpers = { ...original, say: () => "LOUD" };
        try {
          return fn(ctx);
        } finally {
          container.helpers = original;
        }
      },
    };
    const helpers = { say: () => "quiet" };
    expect(expectParity("{{#if true}}{{* shout}}{{say}}{{/if}}{{say}}", {}, { decorators, helpers })).toBe("LOUDquiet");
  });
});

// ---------------------------------------------------------------------------
// Whitespace control, end to end
// ---------------------------------------------------------------------------

describe("evaluateProgram: whitespace control parity", () => {
  test("given tildes on mustaches and block tags, should strip exactly what Handlebars strips", () => {
    expect(expectParity("a  {{~v~}}  b\n{{~#if v~}}\n  in\n{{~/if~}}\nc", { v: "x" })).toBe("axbinc");
  });

  test("given a tilde on one side only, should keep whitespace on the other side", () => {
    expect(expectParity("a  {{~v}}  b", { v: "x" })).toBe("ax  b");
  });

  test("given standalone block, else, and close lines, should remove the whole line", () => {
    const template = "<ul>\n{{#each items}}\n  <li>{{this}}</li>\n{{else}}\n  <li>none</li>\n{{/each}}\n</ul>\n";
    expect(expectParity(template, { items: ["a", "b"] })).toBe("<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n");
    expect(expectParity(template, { items: [] })).toBe("<ul>\n  <li>none</li>\n</ul>\n");
  });

  test("given a standalone comment, should remove its line without touching surrounding lines", () => {
    expect(expectParity("one\n  {{! note }}\ntwo\n{{!-- block\ncomment --}}\nthree")).toBe("one\ntwo\nthree");
  });

  test("given a mustache alone on a line, should keep the line because mustaches are never standalone", () => {
    expect(expectParity("a\n  {{v}}\nb", { v: "x" })).toBe("a\n  x\nb");
  });

  test("given a standalone chained else-if, should strip every link of the chain", () => {
    const template = "{{#if a}}\n  A\n{{else if b}}\n  B\n{{else}}\n  C\n{{/if}}\n";
    expect(expectParity(template, { a: 1 })).toBe("  A\n");
    expect(expectParity(template, { b: 1 })).toBe("  B\n");
    expect(expectParity(template, {})).toBe("  C\n");
  });

  test("given a standalone partial inside an indented block, should indent partial lines by the partial's own indent", () => {
    const template = "{{#each items}}\n    {{> row}}\n{{/each}}";
    const partials = { row: "<li>\n  {{this}}\n</li>\n" };
    expect(expectParity(template, { items: [1, 2] }, { partials, parse: parseWithoutProcessing })).toBe(
      "    <li>\n      1\n    </li>\n    <li>\n      2\n    </li>\n",
    );
  });

  test("given ignoreStandalone, should keep standalone lines while still honouring tildes", () => {
    expect(expectParity("{{#if a}}\n  x\n{{/if}}\n{{~v}}", { a: 1, v: "y" }, { ignoreStandalone: true })).toBe("\n  x\ny");
  });

  test("given windows line endings, should treat them as line breaks for standalone detection", () => {
    expect(expectParity("a\r\n{{#if a}}\r\nb\r\n{{/if}}\r\nc", { a: 1 })).toBe("a\r\nb\r\nc");
  });
});

// ---------------------------------------------------------------------------
// Security: prototype access
// ---------------------------------------------------------------------------

describe("evaluateProgram: prototype access control", () => {
  class Model {
    own = "own";
    get secret(): string {
      return "s";
    }
    greet(this: Model): string {
      return `hi ${this.own}`;
    }
  }

  test("given __proto__ in a path, should never resolve it, even when inherited access is allowed by default", () => {
    const template = "[{{__proto__}}][{{__proto__.constructor}}][{{a.__proto__.polluted}}][{{lookup this '__proto__'}}]";
    const context = { a: {} };
    expect(expectParity(template, context)).toBe("[][][][]");
    expect(expectParity(template, context, { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true })).toBe(
      "[][][][]",
    );
  });

  test("given an inherited constructor, should render nothing and not expose Function through it", () => {
    const template = "[{{constructor}}][{{constructor.name}}][{{constructor.constructor}}][{{lookup this 'constructor'}}]";
    expect(expectParity(template, new Model())).toBe("[][][][]");
    expect(expectParity(template, new Model(), { allowProtoMethodsByDefault: true })).toBe("[][][][]");
  });

  test("given a prototype object as context, should deny its own constructor back-reference", () => {
    expect(expectParity("[{{constructor}}][{{constructor.name}}]", Model.prototype)).toBe("[][]");
  });

  test("given an own property that happens to be named constructor, should read it", () => {
    expect(expectParity("{{constructor}}", { constructor: "plain" })).toBe("plain");
  });

  test("given an inherited getter, should deny it by default and allow it through either whitelist", () => {
    const model = new Model();
    expect(expectParity("[{{own}}][{{secret}}]", model)).toBe("[own][]");
    expect(expectParity("[{{own}}][{{secret}}]", model, { allowProtoPropertiesByDefault: true })).toBe("[own][s]");
    expect(expectParity("[{{own}}][{{secret}}]", model, { allowedProtoProperties: { secret: true } })).toBe("[own][s]");
  });

  test("given an inherited method, should deny it by default and call it with the context as this when allowed", () => {
    const model = new Model();
    expect(expectParity("[{{greet}}]", model)).toBe("[]");
    expect(expectParity("[{{greet}}]", model, { allowProtoMethodsByDefault: true })).toBe("[hi own]");
    expect(expectParity("[{{greet}}]", model, { allowedProtoMethods: { greet: true } })).toBe("[hi own]");
  });

  test("given a per-name denial over a permissive default, should deny that name only", () => {
    const model = new Model();
    const options: EvaluateOptions = { allowProtoPropertiesByDefault: true, allowedProtoProperties: { secret: false } };
    expect(expectParity("[{{secret}}][{{own}}]", model, options)).toBe("[][own]");
  });

  test("given property access from helpers, blocks, and partials, should apply the same rules everywhere", () => {
    const model = new Model();
    const template = "{{#with this}}[{{secret}}]{{/with}}{{#each this}}[{{@key}}]{{/each}}{{> p}}";
    const options = { partials: { p: "[{{secret}}]" }, parse: parseWithoutProcessing };
    expect(expectParity(template, model, options)).toBe("[][own][]");
    expect(expectParity(template, model, { ...options, allowProtoPropertiesByDefault: true })).toBe("[s][own][s]");
  });

  test("given a Function-typed value in the context, should not reach its prototype chain by name", () => {
    const context = { fn: () => "called" };
    expect(expectParity("[{{fn.constructor}}][{{fn.call}}][{{fn.bind}}]", context)).toBe("[][][]");
  });
});

// ---------------------------------------------------------------------------
// Handlebars 4.7 differential corpus
// ---------------------------------------------------------------------------

describe("evaluateProgram: Handlebars 4.7 differential corpus", () => {
  const createHelpers = (): EvaluateOptions["helpers"] => ({
    add: (a: number, b: number) => a + b,
    raw: (options: { fn: () => string }) => options.fn(),
    echo: (v: unknown) => v,
    obj: () => ({ a: 1 }),
    safe: (v: string) => new SafeString(v),
    show: (options: { hash: Record<string, unknown> }) => JSON.stringify(options.hash),
    args: (...args: unknown[]) => JSON.stringify(args.slice(0, -1)),
    yes: () => true,
  });

  const cases: ReadonlyArray<{ name: string; template: string; context?: unknown; options?: EvaluateOptions }> = [
    { name: "a raw block", template: "{{{{raw}}}} {{x}} {{{{/raw}}}}", context: { x: 1 } },
    { name: "a caret else inside a block", template: "{{#if a}}A{{^}}notA{{/if}}", context: {} },
    { name: "an inverse section with an else", template: "{{^a}}no{{else}}yes{{/a}}", context: { a: 1 } },
    { name: "array index segments", template: "{{list.[0]}}|{{list.[1].n}}|{{list.length}}", context: { list: ["x", { n: "y" }] } },
    { name: "a slash path through this", template: "{{this/n}}|{{./n}}", context: { n: 1 } },
    { name: "numeric and negative literals", template: "{{add 1 2}}|{{add -1 2}}|{{add 1.5 0.5}}", context: {} },
    { name: "an escaped quote in a string literal", template: `{{echo "say \\"hi\\""}}|{{echo 'it\\'s'}}`, context: {} },
    { name: "every escapable character", template: "{{v}}", context: { v: "&<>\"'`=" } },
    { name: "helpers returning zero, false, null, undefined, and an object", template: "[{{echo 0}}][{{echo false}}][{{echo null}}][{{echo undefined}}][{{obj}}]", context: {} },
    { name: "a SafeString from a helper and a sub-expression", template: "{{safe '<i>'}}|{{echo (safe '<b>')}}", context: {} },
    { name: "a hash built from data variables", template: "{{#each items}}{{show i=@index f=@first}}{{/each}}", context: { items: ["a", "b"] } },
    { name: "a hash on a partial with an explicit context", template: "{{> p other a=1}}", context: { other: { b: 2 } }, options: { partials: { p: "{{a}}{{b}}" }, parse: parseWithoutProcessing } },
    { name: "block params declared but not supplied", template: "{{#each items as |v k extra|}}{{v}}{{k}}[{{extra}}]{{/each}}", context: { items: ["x"] } },
    { name: "deeply nested blocks with mixed data and context paths", template: "{{#each rows}}{{#with cells}}{{#if ../flag}}{{@../index}}:{{this}}{{/if}}{{/with}}{{/each}}", context: { rows: [{ flag: true, cells: "c" }, { flag: false, cells: "d" }] } },
    { name: "an each over a Map", template: "{{#each m}}{{@key}}={{this}}{{#unless @last}},{{/unless}}{{/each}}", context: { m: new Map([["a", 1], ["b", 2]]) } },
    { name: "an each over a Set", template: "{{#each s}}{{@index}}:{{this}} {{/each}}", context: { s: new Set(["x", "y"]) } },
    { name: "an each over a string-keyed object with numeric-looking keys", template: "{{#each o}}{{@key}}{{/each}}", context: { o: { 2: "a", 1: "b", x: "c" } } },
    { name: "a helper used as a sub-expression inside a block parameter", template: "{{#with (obj) as |it|}}{{it.a}}{{/with}}", context: {} },
    { name: "positional arguments of every literal kind", template: "{{args 1 'two' true null undefined x}}", context: { x: [1] } },
    { name: "a with over a falsy-but-present value", template: "{{#with n}}[{{this}}]{{else}}none{{/with}}", context: { n: 0 } },
    { name: "an if over a function that returns zero", template: "{{#if f}}T{{else}}F{{/if}}", context: { f: () => 0 } },
    { name: "a helper call where this is the loop item", template: "{{#each items}}{{yes}}{{this}}{{/each}}", context: { items: ["a"] } },
    { name: "unicode content and values", template: "é {{v}} 日本", context: { v: "ü" } },
    { name: "a comment adjacent to a mustache", template: "{{v}}{{!x}}{{v}}", context: { v: 1 } },
    { name: "an each with else inside a partial block", template: "{{#> wrap}}{{#each items}}{{this}}{{else}}empty{{/each}}{{/wrap}}", context: { items: [] }, options: { partials: { wrap: "<{{> @partial-block}}>" }, parse: parseWithoutProcessing } },
    { name: "a dynamic partial with a hash", template: "{{> (echo 'p') x=1}}", context: {}, options: { partials: { p: "[{{x}}]" }, parse: parseWithoutProcessing } },
    { name: "a partial that recurses", template: "{{> tree}}", context: { n: "a", kids: [{ n: "b", kids: [] }, { n: "c", kids: [{ n: "d", kids: [] }] }] }, options: { partials: { tree: "{{n}}({{#each kids}}{{> tree}}{{/each}})" }, parse: parseWithoutProcessing } },
  ];

  for (const { name, template, context, options } of cases) {
    test(`given ${name}, should render exactly what Handlebars 4.7 renders`, () => {
      expectParity(template, context, { ...options, helpers: { ...createHelpers(), ...options?.helpers } });
    });
  }
});

// ---------------------------------------------------------------------------
// CSP: no dynamic code anywhere in the runtime
// ---------------------------------------------------------------------------

describe("source: CSP safety", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));

  test("given the runtime sources, should contain no eval, Function constructor, or string timers", () => {
    const banned = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bset(?:Timeout|Interval)\s*\(\s*["'`]/];
    const offenders = sourceFiles.flatMap((name) => {
      const text = readFileSync(new URL(name, `file://${srcDir}`), "utf8");
      return banned.filter((pattern) => pattern.test(text)).map((pattern) => `${name}: ${pattern.source}`);
    });
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("given a locked-down global scope, should still render templates", () => {
    const originalEval = globalThis.eval;
    const originalFunction = globalThis.Function;
    const blocked = () => {
      throw new EvalError("blocked by CSP");
    };
    globalThis.eval = blocked as typeof eval;
    (globalThis as { Function: unknown }).Function = blocked;
    try {
      expect(render("{{#each items}}{{> p}}{{/each}}", { items: [1, 2] }, { partials: { p: "[{{this}}]" }, parse: parseWithoutProcessing })).toBe("[1][2]");
    } finally {
      globalThis.eval = originalEval;
      globalThis.Function = originalFunction;
    }
  });
});
