import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";
import { parseWithoutProcessing } from "@handlebars/parser";

import {
  compileAST,
  createEnvironment,
  createLogger,
  isRuntimeError,
  processWhitespace,
  renderAST,
  SafeString,
  Utils,
  type HelperDelegate,
  type HelperOptions,
  type Logger,
} from "../src/index";

const parse = parseWithoutProcessing;

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

/** A logger that records every emitted message instead of writing to the console. */
const createRecordingLogger = (level: number | string = "info"): { logger: Logger; messages: unknown[][] } => {
  const messages: unknown[][] = [];
  const record = (...message: unknown[]) => void messages.push(message);
  const logger = createLogger({ level, output: { debug: record, info: record, warn: record, error: record, log: record } });
  return { logger, messages };
};

// ---------------------------------------------------------------------------
// createEnvironment: registries
// ---------------------------------------------------------------------------

describe("createEnvironment: helpers", () => {
  test("given a helper registered by name, should make it callable from templates compiled against the environment", () => {
    const env = createEnvironment();
    env.registerHelper("up", (text: unknown) => String(text).toUpperCase());
    expect(compileAST(parse("{{up name}}"), env)({ name: "ada" })).toBe("ADA");
  });

  test("given a map of helpers, should register every entry", () => {
    const env = createEnvironment();
    env.registerHelper({ a: () => "A", b: () => "B" });
    expect(compileAST(parse("{{a}}{{b}}"), env)({})).toBe("AB");
  });

  test("given a helper registered after compile, should still be visible at render time", () => {
    const env = createEnvironment();
    const template = compileAST(parse("{{late}}"), env);
    env.registerHelper("late", () => "seen");
    expect(template({})).toBe("seen");
  });

  test("given an unregistered helper, should fall back to the context property of that name", () => {
    const env = createEnvironment({ helpers: { who: () => "helper" } });
    env.unregisterHelper("who");
    expect(compileAST(parse("{{who}}"), env)({ who: "context" })).toBe("context");
  });

  test("given a name without a helper, should throw invalid-arguments naming the helper", () => {
    const env = createEnvironment();
    expectRuntimeError(
      () => (env.registerHelper as unknown as (name: string) => void)("nothing"),
      "invalid-arguments",
      'Attempting to register a helper called "nothing" as undefined',
    );
  });

  test("given a helper map together with a second argument, should throw invalid-arguments", () => {
    const env = createEnvironment();
    expectRuntimeError(
      () => (env.registerHelper as (map: object, extra: unknown) => void)({ a: () => "A" }, () => "B"),
      "invalid-arguments",
      "Arg not supported with multiple helpers",
    );
  });

  test("given a template that reads a helper-looking inherited name, should not find it on the registry prototype", () => {
    const env = createEnvironment();
    expect(compileAST(parse("[{{constructor}}][{{toString}}]"), env)({})).toBe("[][]");
  });
});

describe("createEnvironment: partials", () => {
  test("given a parse function and a string partial, should parse and render the partial", () => {
    const env = createEnvironment({ parse });
    env.registerPartial("greet", "Hi {{name}}");
    expect(compileAST(parse("{{> greet}}!"), env)({ name: "Ada" })).toBe("Hi Ada!");
  });

  test("given a map of partials, should register every entry", () => {
    const env = createEnvironment({ parse });
    env.registerPartial({ a: "A", b: parse("B") });
    expect(compileAST(parse("{{> a}}{{> b}}"), env)({})).toBe("AB");
  });

  test("given a partial removed from the environment, should no longer resolve", () => {
    const env = createEnvironment({ parse, partials: { p: "x" } });
    env.unregisterPartial("p");
    expectRuntimeError(() => compileAST(parse("{{> p}}"), env)({}), "missing-partial", "The partial p could not be found");
  });

  test("given an undefined partial, should throw invalid-arguments naming the partial", () => {
    const env = createEnvironment();
    expectRuntimeError(
      () => (env.registerPartial as unknown as (name: string) => void)("layout"),
      "invalid-arguments",
      'Attempting to register a partial called "layout" as undefined',
    );
  });

  test("given a string partial on an environment without a parser, should throw invalid-partial at render time", () => {
    const env = createEnvironment();
    env.registerPartial("p", "{{x}}");
    expectRuntimeError(() => compileAST(parse("{{> p}}"), env)({}), "invalid-partial", "no parse function was provided");
  });
});

describe("createEnvironment: decorators", () => {
  test("given a decorator registered by name, should apply it to programs that reference it", () => {
    const env = createEnvironment();
    env.registerDecorator("wrap", (fn) => (context) => `<${fn(context)}>`);
    expect(compileAST(parse("{{* wrap}}body"), env)({})).toBe("<body>");
  });

  test("given a map of decorators, should register every entry", () => {
    const env = createEnvironment();
    env.registerDecorator({
      a: (fn) => (context) => `a${fn(context)}`,
      b: (fn) => (context) => `b${fn(context)}`,
    });
    expect(compileAST(parse("{{* a}}{{* b}}."), env)({})).toBe("ba.");
  });

  test("given a decorator removed from the environment, should throw missing-decorator", () => {
    const env = createEnvironment({ decorators: { d: (fn) => fn } });
    env.unregisterDecorator("d");
    expectRuntimeError(() => compileAST(parse("{{* d}}"), env)({}), "missing-decorator", 'Missing decorator: "d"');
  });

  test("given the built-in inline decorator, should remain available alongside registered ones", () => {
    const env = createEnvironment();
    expect(compileAST(parse('{{#*inline "p"}}in{{/inline}}{{> p}}'), env)({})).toBe("in");
  });
});

// ---------------------------------------------------------------------------
// createEnvironment: options and logger
// ---------------------------------------------------------------------------

describe("createEnvironment: runtime option defaults", () => {
  test("given environment options, should apply them to every render", () => {
    const env = createEnvironment({ noEscape: true });
    expect(compileAST(parse("{{v}}"), env)({ v: "<" })).toBe("<");
  });

  test("given render-time options, should override the environment defaults for that render only", () => {
    const env = createEnvironment({ noEscape: true });
    const template = compileAST(parse("{{v}}"), env);
    expect(template({ v: "<" }, { noEscape: false })).toBe("&lt;");
    expect(template({ v: "<" })).toBe("<");
  });

  test("given render-time helpers, should layer them over the environment helpers without mutating the registry", () => {
    const env = createEnvironment({ helpers: { a: () => "envA", b: () => "envB" } });
    const template = compileAST(parse("{{a}}{{b}}"), env);
    expect(template({}, { helpers: { a: () => "renderA" } })).toBe("renderAenvB");
    expect(template({})).toBe("envAenvB");
    expect(Object.keys(env.helpers)).toEqual(["a", "b"]);
  });

  test("given render-time partials, should layer them over the environment partials", () => {
    const env = createEnvironment({ parse, partials: { p: "env" } });
    const template = compileAST(parse("{{> p}}"), env);
    expect(template({}, { partials: { p: "render" } })).toBe("render");
    expect(template({})).toBe("env");
  });

  test("given the environment's logger, should receive {{log}} output at or above its level", () => {
    const { logger, messages } = createRecordingLogger();
    const env = createEnvironment({ logger });
    compileAST(parse("{{log 'hello' level='warn'}}{{log 'quiet' level='debug'}}"), env)({});
    expect(messages).toEqual([["hello"]]);
  });

  test("given no logger, should create one per environment whose level can be changed later", () => {
    const env = createEnvironment();
    const other = createEnvironment();
    env.logger.level = "error";
    expect(other.logger.level).toBe("info");
    expect(env.logger).not.toBe(other.logger);
  });

  test("given a render-time logger, should take precedence over the environment logger", () => {
    const envLog = createRecordingLogger();
    const renderLog = createRecordingLogger();
    const env = createEnvironment({ logger: envLog.logger });
    compileAST(parse("{{log 'x'}}"), env)({}, { logger: renderLog.logger });
    expect(envLog.messages).toEqual([]);
    expect(renderLog.messages).toEqual([["x"]]);
  });

  test("given a prototype access denial, should warn through the environment logger", () => {
    const { logger, messages } = createRecordingLogger();
    const env = createEnvironment({ logger });
    class Model {
      get secret(): string {
        return "s";
      }
    }
    compileAST(parse("{{secret}}"), env)(new Model());
    expect(messages.length).toBe(1);
    expect(String(messages[0]?.[0])).toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// compileAST and renderAST
// ---------------------------------------------------------------------------

describe("compileAST", () => {
  test("given no environment, should render with the built-in helpers and render-time options only", () => {
    const template = compileAST(parse("{{#if ok}}{{up v}}{{/if}}"));
    expect(template({ ok: true, v: "a" }, { helpers: { up: (s: unknown) => String(s).toUpperCase() } })).toBe("A");
  });

  test("given a compiled template rendered twice, should produce the same output each time", () => {
    const template = compileAST(parse("  {{#each items}}\n  {{this}}\n  {{/each}}\n"));
    const first = template({ items: [1, 2] });
    expect(first).toBe("  1\n  2\n");
    expect(template({ items: [1, 2] })).toBe(first);
  });

  test("given processWhitespace false at render time, should leave an unprocessed AST untouched", () => {
    const template = compileAST(parse("  {{~v~}}  "));
    expect(template({ v: 1 }, { processWhitespace: false })).toBe("  1  ");
  });

  test("given a value that is not a Program node, should throw invalid-program", () => {
    expectRuntimeError(() => compileAST({ type: "MustacheStatement", body: [] }), "invalid-program", "MustacheStatement");
    expectRuntimeError(() => compileAST(null as never), "invalid-program", "null");
  });

  test("given a context type parameter, should type the delegate's context", () => {
    const template = compileAST<{ name: string }>(parse("{{name}}"));
    expect(template({ name: "typed" })).toBe("typed");
  });
});

describe("renderAST", () => {
  test("given an AST, context, and options, should render in one call", () => {
    expect(renderAST(parse("{{greet name}}"), { name: "Ada" }, { helpers: { greet: (n: unknown) => `Hi ${String(n)}` } })).toBe(
      "Hi Ada",
    );
  });

  test("given a parse option, should resolve string partials", () => {
    expect(renderAST(parse("{{> p}}"), { x: 1 }, { parse, partials: { p: "[{{x}}]" } })).toBe("[1]");
  });

  test("given no context, should render with an undefined context", () => {
    expect(renderAST(parse("[{{this}}]"))).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// Parity with Handlebars.create()
// ---------------------------------------------------------------------------

describe("createEnvironment: parity with Handlebars.create()", () => {
  /** The registration surface both engines share, so one callback can configure each. */
  interface Registrar {
    registerHelper(name: string, helper: HelperDelegate): void;
    registerPartial(name: string, partial: string): void;
  }

  const setup = (register: (target: Registrar) => void) => {
    const hb = Handlebars.create();
    const env = createEnvironment({ parse });
    register(hb);
    register(env);
    return { hb, env };
  };

  test("given the same helpers and partials, should render exactly what Handlebars renders", () => {
    const { hb, env } = setup((target) => {
      target.registerHelper("shout", function (this: unknown, text: unknown, options: HelperOptions) {
        return new SafeString(`<b>${Utils.escapeExpression(text)}</b>${options.hash.suffix ?? ""}`);
      });
      target.registerPartial("row", "<li>{{shout this suffix='!'}}</li>\n");
    });
    const template = "<ul>\n{{#each items}}\n  {{> row}}\n{{/each}}\n</ul>";
    const context = { items: ["a & b", "<c>"] };
    expect(compileAST(parse(template), env)(context)).toBe(hb.compile(template)(context));
  });

  test("given two environments, should keep their registries independent", () => {
    const one = createEnvironment({ helpers: { who: () => "one" } });
    const two = createEnvironment({ helpers: { who: () => "two" } });
    const ast = parse("{{who}}");
    expect(compileAST(ast, one)({})).toBe("one");
    expect(compileAST(ast, two)({})).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// Utilities exported from the package root
// ---------------------------------------------------------------------------

describe("index: utilities", () => {
  test("given Utils.escapeExpression, should escape like Handlebars.Utils.escapeExpression", () => {
    const sample = `<a href="x">'&'</a> \` =`;
    expect(Utils.escapeExpression(sample)).toBe(Handlebars.Utils.escapeExpression(sample));
  });

  test("given Utils.isEmpty, should agree with Handlebars.Utils.isEmpty on every falsy shape", () => {
    for (const value of [null, undefined, false, "", [], 0, "0", [0], {}]) {
      expect(Utils.isEmpty(value)).toBe(Handlebars.Utils.isEmpty(value));
    }
  });

  test("given Utils.createFrame, should copy own keys and link the parent like Handlebars.createFrame", () => {
    const parent = { root: 1, index: 0 };
    const frame = Utils.createFrame(parent);
    expect(frame).toEqual(Handlebars.createFrame(parent));
    expect(frame._parent).toBe(parent);
  });

  test("given a SafeString, should be emitted unescaped by renderAST", () => {
    expect(renderAST(parse("{{v}}"), { v: new SafeString("<i>") })).toBe("<i>");
  });

  test("given processWhitespace, should be callable directly and return the same program", () => {
    const program = parse("{{#if a}}\n  x\n{{/if}}\n");
    expect(processWhitespace(program)).toBe(program);
    expect(renderAST(program, { a: true }, { processWhitespace: false })).toBe("  x\n");
  });
});
