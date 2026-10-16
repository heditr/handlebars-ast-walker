import { describe, expect, test, vi } from "vitest";

import { createLogger, lookupLevel } from "../src/logger";

/** A console stand-in that records every call instead of printing. */
const createOutput = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
});

describe("lookupLevel", () => {
  test("given a level name in any casing, should map it to its numeric index", () => {
    expect(lookupLevel("debug")).toBe(0);
    expect(lookupLevel("INFO")).toBe(1);
    expect(lookupLevel("Warn")).toBe(2);
    expect(lookupLevel("error")).toBe(3);
  });

  test("given a numeric level or a numeric string, should return the number", () => {
    expect(lookupLevel(2)).toBe(2);
    expect(lookupLevel("3")).toBe(3);
  });

  test("given an unknown level name, should produce NaN so nothing is emitted", () => {
    expect(lookupLevel("verbose")).toBeNaN();
  });
});

describe("createLogger", () => {
  test("given the default threshold, should emit info and above through the matching console method", () => {
    const output = createOutput();
    const logger = createLogger({ output });

    logger.log("info", "a");
    logger.log("warn", "b");
    logger.log("error", "c", "d");

    expect(output.info).toHaveBeenCalledWith("a");
    expect(output.warn).toHaveBeenCalledWith("b");
    expect(output.error).toHaveBeenCalledWith("c", "d");
  });

  test("given the default threshold, should suppress debug messages", () => {
    const output = createOutput();
    const logger = createLogger({ output });

    logger.log("debug", "hidden");
    logger.log(0, "also hidden");

    expect(output.debug).not.toHaveBeenCalled();
  });

  test("given a lowered threshold after creation, should honor the new level on the next call", () => {
    const output = createOutput();
    const logger = createLogger({ output });

    logger.level = "debug";
    logger.log("debug", "shown");

    expect(output.debug).toHaveBeenCalledWith("shown");
  });

  test("given a numeric level beyond the known methods, should fall back to console.log", () => {
    const output = createOutput();
    const logger = createLogger({ output });

    logger.log(7, "fallback");

    expect(output.log).toHaveBeenCalledWith("fallback");
  });

  test("given an unknown level name, should emit nothing", () => {
    const output = createOutput();
    const logger = createLogger({ output });

    logger.log("verbose", "nope");

    expect(output.log).not.toHaveBeenCalled();
    expect(output.info).not.toHaveBeenCalled();
  });
});
