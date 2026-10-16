import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";

import { isRuntimeError } from "../src/errors";
import {
  blockHelperMissing,
  createBuiltinHelpers,
  createLogHelper,
  eachHelper,
  helperMissing,
  ifHelper,
  isEmpty,
  lookupHelper,
  unlessHelper,
  withHelper,
} from "../src/helpers";
import { createLogger } from "../src/logger";
import { createLookupProperty } from "../src/lookup";
import { createFrame } from "../src/scope";
import type { BlockOptions, DataFrame, HelperDelegate, HelperOptions } from "../src/types";

// ---------------------------------------------------------------------------
// Test doubles: real block renderers that describe how they were invoked
// ---------------------------------------------------------------------------

/**
 * A block renderer that returns a description of its call. Data is read at
 * call time because `#each` reuses one frame across iterations.
 */
const describeCall =
  (label: string) =>
  (context?: unknown, options?: BlockOptions): string => {
    const parts = [label, JSON.stringify(context) ?? String(context)];
    if (options?.blockParams !== undefined) parts.push(`params=${JSON.stringify(options.blockParams)}`);
    const data = options?.data;
    if (data !== undefined) {
      parts.push(`data=${[data.index, data.key, data.first, data.last].map(String).join(":")}`);
    }
    return `[${parts.join(" ")}]`;
  };

const createOptions = ({
  name = "test",
  hash = {},
  data,
  lookupProperty = createLookupProperty(),
}: {
  name?: string;
  hash?: Record<string, unknown>;
  data?: DataFrame | undefined;
  lookupProperty?: HelperOptions["lookupProperty"];
} = {}): HelperOptions => ({
  name,
  hash,
  data,
  lookupProperty,
  fn: describeCall("fn"),
  inverse: describeCall("inverse"),
});

type AnyHelper = (this: unknown, ...args: unknown[]) => unknown;

const oracle = Handlebars.helpers as unknown as Record<string, AnyHelper>;

/**
 * Invokes our helper and the Handlebars 4.7.10 helper of the same name with
 * identical inputs and asserts their results agree. Pass a function for
 * `params` when an argument is consumed by iteration, such as a generator.
 */
const expectParity = (
  name: string,
  ours: HelperDelegate,
  thisArg: unknown,
  params: unknown[] | (() => unknown[]),
  makeOptions: () => HelperOptions = () => createOptions(),
): unknown => {
  const makeParams = typeof params === "function" ? params : () => params;
  const actual = ours.call(thisArg, ...makeParams(), makeOptions());
  const expected = (oracle[name] as AnyHelper).call(thisArg, ...makeParams(), makeOptions());
  expect(actual).toEqual(expected);
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
// isEmpty
// ---------------------------------------------------------------------------

describe("isEmpty", () => {
  test("given falsy values other than zero or an empty array, should report empty; otherwise not, matching Handlebars.Utils.isEmpty", () => {
    const samples: unknown[] = [false, null, undefined, "", 0, -0, NaN, [], [0], {}, "a", 1, () => 1];

    for (const value of samples) {
      expect(isEmpty(value)).toBe(Handlebars.Utils.isEmpty(value));
    }
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// if / unless
// ---------------------------------------------------------------------------

describe("if", () => {
  test("given a truthy, non-empty value, should render the block with the current context", () => {
    const context = { name: "Ada" };

    expect(expectParity("if", ifHelper, context, ["yes"])).toBe('[fn {"name":"Ada"}]');
  });

  test("given falsy or empty values, should render the inverse with the current context", () => {
    const context = { name: "Ada" };

    for (const value of [false, null, undefined, "", 0, []]) {
      expect(expectParity("if", ifHelper, context, [value])).toBe('[inverse {"name":"Ada"}]');
    }
  });

  test("given zero with includeZero, should render the block", () => {
    const options = () => createOptions({ hash: { includeZero: true } });

    expect(expectParity("if", ifHelper, {}, [0], options)).toBe("[fn {}]");
    expect(expectParity("if", ifHelper, {}, [""], options)).toBe("[inverse {}]");
  });

  test("given a function as the condition, should call it with the context as this and test its result", () => {
    const context = { flag: true };
    const condition = function (this: { flag: boolean }) {
      return this.flag;
    };

    expect(expectParity("if", ifHelper, context, [condition])).toBe('[fn {"flag":true}]');
  });

  test("given a missing or extra argument, should throw an invalid-arguments error", () => {
    expectRuntimeError(() => ifHelper.call({}, createOptions()), "invalid-arguments", "#if requires exactly one argument");
    expectRuntimeError(
      () => ifHelper.call({}, 1, 2, createOptions()),
      "invalid-arguments",
      "#if requires exactly one argument",
    );
    expect(() => (oracle.if as AnyHelper).call({}, createOptions())).toThrow("#if requires exactly one argument");
  });
});

describe("unless", () => {
  test("given the same inputs as if, should render the opposite branch", () => {
    const context = { name: "Ada" };

    expect(expectParity("unless", unlessHelper, context, ["yes"])).toBe('[inverse {"name":"Ada"}]');
    expect(expectParity("unless", unlessHelper, context, [""])).toBe('[fn {"name":"Ada"}]');
    expect(expectParity("unless", unlessHelper, context, [0], () => createOptions({ hash: { includeZero: true } }))).toBe(
      '[inverse {"name":"Ada"}]',
    );
  });

  test("given a missing argument, should throw an invalid-arguments error", () => {
    expectRuntimeError(
      () => unlessHelper.call({}, createOptions()),
      "invalid-arguments",
      "#unless requires exactly one argument",
    );
  });
});

// ---------------------------------------------------------------------------
// with
// ---------------------------------------------------------------------------

describe("with", () => {
  test("given a non-empty value, should render the block with that value as context and as the first block param", () => {
    const frame = createFrame();
    const options = () => createOptions({ data: frame });

    expect(expectParity("with", withHelper, {}, [{ city: "Paris" }], options)).toBe(
      '[fn {"city":"Paris"} params=[{"city":"Paris"}] data=undefined:undefined:undefined:undefined]',
    );
  });

  test("given an empty value, should render the inverse with the current context", () => {
    const context = { name: "Ada" };

    for (const value of [undefined, null, false, "", []]) {
      expect(expectParity("with", withHelper, context, [value])).toBe('[inverse {"name":"Ada"}]');
    }
  });

  test("given a function, should call it with the context as this and use its result", () => {
    const context = { inner: { x: 1 } };
    const getInner = function (this: typeof context) {
      return this.inner;
    };

    expect(expectParity("with", withHelper, context, [getInner])).toBe('[fn {"x":1} params=[{"x":1}]]');
  });

  test("given a missing argument, should throw an invalid-arguments error", () => {
    expectRuntimeError(
      () => withHelper.call({}, createOptions()),
      "invalid-arguments",
      "#with requires exactly one argument",
    );
  });
});

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

describe("lookup", () => {
  test("given an object and a key, should read through lookupProperty so prototype access rules apply", () => {
    const options = createOptions();

    expect(lookupHelper.call({}, { a: 1 }, "a", options)).toBe(1);
    expect(lookupHelper.call({}, { a: 1 }, "constructor", options)).toBeUndefined();
    expect(lookupHelper.call({}, ["x", "y"], 1, options)).toBe("y");
  });

  test("given a falsy subject, should return it unchanged, as Handlebars 4 does", () => {
    for (const subject of [undefined, null, 0, "", false]) {
      expect(expectParity("lookup", lookupHelper, {}, [subject, "a"])).toBe(subject);
    }
  });
});

// ---------------------------------------------------------------------------
// each
// ---------------------------------------------------------------------------

describe("each", () => {
  const withData = () => createOptions({ data: createFrame({ root: "r" }) });

  test("given an array, should render each item with index, key, first and last data and [value, index] block params", () => {
    expect(expectParity("each", eachHelper, {}, [["a", "b", "c"]], withData)).toBe(
      '[fn "a" params=["a",0] data=0:0:true:false]' +
        '[fn "b" params=["b",1] data=1:1:false:false]' +
        '[fn "c" params=["c",2] data=2:2:false:true]',
    );
  });

  test("given a sparse array, should skip holes but keep the original indices", () => {
    const sparse = ["a", , "c"]; // eslint-disable-line no-sparse-arrays

    expect(expectParity("each", eachHelper, {}, [sparse], withData)).toBe(
      '[fn "a" params=["a",0] data=0:0:true:false][fn "c" params=["c",2] data=2:2:false:true]',
    );
  });

  test("given a plain object, should iterate own enumerable keys in order with the key as @key and a running @index", () => {
    const inherited = Object.create({ hidden: 1 }) as Record<string, number>;
    inherited.x = 10;
    inherited.y = 20;

    expect(expectParity("each", eachHelper, {}, [inherited], withData)).toBe(
      '[fn 10 params=[10,"x"] data=0:x:true:false][fn 20 params=[20,"y"] data=1:y:false:true]',
    );
  });

  test("given a Map, Set, or generator, should iterate it with numeric keys and detect the last item", () => {
    const map = new Map([
      ["k1", 1],
      ["k2", 2],
    ]);
    const set = new Set(["only"]);
    const generator = function* () {
      yield "g1";
      yield "g2";
    };

    expect(expectParity("each", eachHelper, {}, [map], withData)).toBe(
      '[fn ["k1",1] params=[["k1",1],0] data=0:0:true:false][fn ["k2",2] params=[["k2",2],1] data=1:1:false:true]',
    );
    expect(expectParity("each", eachHelper, {}, [set], withData)).toBe(
      '[fn "only" params=["only",0] data=0:0:true:true]',
    );
    expect(expectParity("each", eachHelper, {}, () => [generator()], withData)).toBe(
      '[fn "g1" params=["g1",0] data=0:0:true:false][fn "g2" params=["g2",1] data=1:1:false:true]',
    );
  });

  test("given nothing to iterate, should render the inverse once with the current context", () => {
    const context = { name: "Ada" };

    for (const value of [[], {}, new Map(), undefined, null, "", 0, "text", 42]) {
      expect(expectParity("each", eachHelper, context, [value], withData)).toBe('[inverse {"name":"Ada"}]');
    }
  });

  test("given a function, should call it with the context as this and iterate its result", () => {
    const context = { items: [1, 2] };
    const getItems = function (this: typeof context) {
      return this.items;
    };

    expect(expectParity("each", eachHelper, context, [getItems])).toBe('[fn 1 params=[1,0]][fn 2 params=[2,1]]');
  });

  test("given a data frame, should iterate on a child frame that links back to the parent and keeps its keys", () => {
    const parent = createFrame({ root: "r", level: "debug" });
    const seen: DataFrame[] = [];
    const options: HelperOptions = {
      ...createOptions({ data: parent }),
      fn: (_context, blockOptions) => {
        if (blockOptions?.data !== undefined) seen.push(blockOptions.data);
        return "";
      },
    };

    eachHelper.call({}, ["a", "b"], options);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]?._parent).toBe(parent);
    expect(seen[0]?.root).toBe("r");
    expect(seen[0]?.level).toBe("debug");
    expect(parent.index).toBeUndefined();
  });

  test("given no data frame, should render iterations with undefined data", () => {
    expect(expectParity("each", eachHelper, {}, [["a"]])).toBe('[fn "a" params=["a",0]]');
  });

  test("given a block body that throws part-way through a generator, should close the generator before rethrowing", () => {
    let closed = false;
    const generator = function* () {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        closed = true;
      }
    };
    const options: HelperOptions = {
      ...createOptions(),
      fn: (context) => {
        if (context === 2) throw new Error("body failed");
        return String(context);
      },
    };

    expect(() => eachHelper.call({}, generator(), options)).toThrow("body failed");
    expect(closed).toBe(true);
  });

  test("given no options because the template wrote {{#each}} with no argument, should throw an invalid-arguments error", () => {
    expectRuntimeError(() => eachHelper.call({}, createOptions()), "invalid-arguments", "Must pass iterator to #each");
    expect(() => (oracle.each as AnyHelper).call({}, createOptions())).toThrow("Must pass iterator to #each");
  });
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

describe("log", () => {
  const createRecorder = () => {
    const calls: Array<[string, unknown[]]> = [];
    const record =
      (method: string) =>
      (...message: unknown[]) =>
        calls.push([method, message]);
    const output = {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      log: record("log"),
    };
    return { calls, logger: createLogger({ level: "debug", output }) };
  };

  test("given messages and no level, should log them at info level", () => {
    const { calls, logger } = createRecorder();
    const log = createLogHelper(logger);

    log.call({}, "hello", 42, createOptions());

    expect(calls).toEqual([["info", ["hello", 42]]]);
  });

  test("given a level in the hash, should use it; otherwise given @level in data, should use that", () => {
    const { calls, logger } = createRecorder();
    const log = createLogHelper(logger);

    log.call({}, "a", createOptions({ hash: { level: "error" } }));
    log.call({}, "b", createOptions({ data: createFrame({ level: "warn" }) }));
    log.call({}, "c", createOptions({ hash: { level: 0 }, data: createFrame({ level: "warn" }) }));

    expect(calls).toEqual([
      ["error", ["a"]],
      ["warn", ["b"]],
      ["debug", ["c"]],
    ]);
  });

  test("given a message below the logger threshold, should emit nothing", () => {
    const { calls, logger } = createRecorder();
    logger.level = "warn";
    const log = createLogHelper(logger);

    log.call({}, "quiet", createOptions());

    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// helperMissing / blockHelperMissing
// ---------------------------------------------------------------------------

describe("helperMissing", () => {
  test("given only options, as for a missing {{field}}, should return undefined", () => {
    expect(expectParity("helperMissing", helperMissing, {}, [], () => createOptions({ name: "field" }))).toBeUndefined();
  });

  test("given parameters, should throw a missing-helper error naming the helper", () => {
    expectRuntimeError(
      () => helperMissing.call({}, 1, createOptions({ name: "shout" })),
      "missing-helper",
      'Missing helper: "shout"',
    );
    expect(() => (oracle.helperMissing as AnyHelper).call({}, 1, createOptions({ name: "shout" }))).toThrow(
      'Missing helper: "shout"',
    );
  });
});

describe("blockHelperMissing", () => {
  const context = { name: "Ada" };

  test("given true, should render the block with the current context; given false or nullish, the inverse", () => {
    expect(expectParity("blockHelperMissing", blockHelperMissing, context, [true])).toBe('[fn {"name":"Ada"}]');
    for (const value of [false, null, undefined]) {
      expect(expectParity("blockHelperMissing", blockHelperMissing, context, [value])).toBe('[inverse {"name":"Ada"}]');
    }
  });

  test("given a non-empty array, should iterate it like #each; given an empty array, should render the inverse", () => {
    const options = () => createOptions({ data: createFrame() });

    expect(expectParity("blockHelperMissing", blockHelperMissing, context, [["x", "y"]], options)).toBe(
      '[fn "x" params=["x",0] data=0:0:true:false][fn "y" params=["y",1] data=1:1:false:true]',
    );
    expect(expectParity("blockHelperMissing", blockHelperMissing, context, [[]], options)).toBe(
      '[inverse {"name":"Ada"}]',
    );
  });

  test("given any other value, should render the block with that value as context, keeping the data frame", () => {
    const options = () => createOptions({ data: createFrame() });

    expect(expectParity("blockHelperMissing", blockHelperMissing, context, [{ x: 1 }], options)).toBe(
      '[fn {"x":1} data=undefined:undefined:undefined:undefined]',
    );
    expect(expectParity("blockHelperMissing", blockHelperMissing, context, ["str"])).toBe('[fn "str"]');
    expect(expectParity("blockHelperMissing", blockHelperMissing, context, [0])).toBe("[fn 0]");
  });
});

// ---------------------------------------------------------------------------
// createBuiltinHelpers
// ---------------------------------------------------------------------------

describe("createBuiltinHelpers", () => {
  test("given no options, should expose every built-in helper under its Handlebars name", () => {
    const helpers = createBuiltinHelpers();

    expect(Object.keys(helpers).sort()).toEqual(
      ["blockHelperMissing", "each", "helperMissing", "if", "log", "lookup", "unless", "with"].sort(),
    );
    expect(helpers.if).toBe(ifHelper);
    expect(helpers.each).toBe(eachHelper);
  });

  test("given a logger, should route {{log}} output to it", () => {
    const messages: unknown[][] = [];
    const logger = createLogger({
      level: "debug",
      output: {
        debug: () => {},
        info: (...message) => messages.push(message),
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });
    const helpers = createBuiltinHelpers({ logger });

    (helpers.log as HelperDelegate).call({}, "routed", createOptions());

    expect(messages).toEqual([["routed"]]);
  });

  test("given a fresh call, should return a new registry so one render's mutations cannot leak into another", () => {
    const first = createBuiltinHelpers();
    const second = createBuiltinHelpers();

    expect(first).not.toBe(second);
    expect(Object.keys(first)).toEqual(Object.keys(second));
    expect(first.log).not.toBe(second.log);
  });
});
