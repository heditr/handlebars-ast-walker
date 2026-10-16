/**
 * Logger with Handlebars 4.7 semantics, used by `{{log}}` and by the
 * prototype-access warnings.
 *
 * @packageDocumentation
 */

import type { Logger } from "./types";

/** Console methods in level order: `0` debug, `1` info, `2` warn, `3` error. */
const methodMap = ["debug", "info", "warn", "error"] as const;

type LevelMethod = (typeof methodMap)[number];

/** The subset of `console` a logger writes to. */
export type LogOutput = Record<LevelMethod | "log", (...message: unknown[]) => void>;

/**
 * Normalizes a log level to its numeric index.
 *
 * Level names are matched case-insensitively against `debug`, `info`,
 * `warn`, and `error`. Any other string is parsed as an integer, so an
 * unknown name yields `NaN`, which never satisfies a threshold check.
 *
 * @param level - A level index, a level name, or a numeric string.
 * @returns The numeric level.
 */
export const lookupLevel = (level: number | string): number => {
  if (typeof level !== "string") return level;
  const index = (methodMap as readonly string[]).indexOf(level.toLowerCase());
  return index >= 0 ? index : Number.parseInt(level, 10);
};

/**
 * Creates a {@link Logger} that forwards messages at or above its `level`
 * to the matching console method. Levels without a dedicated method fall
 * back to `log`. The `level` property is mutable, mirroring
 * `Handlebars.logger.level`.
 *
 * @param options.level - Minimum level to emit. Defaults to `"info"`.
 * @param options.output - Destination methods. Defaults to the global `console`.
 * @returns A logger instance.
 *
 * @example
 * ```ts
 * const logger = createLogger({ level: "debug" });
 * logger.log("debug", "rendering", templateName);
 * ```
 */
export const createLogger = ({
  level = "info",
  output = globalThis.console,
}: { level?: number | string; output?: LogOutput } = {}): Logger => {
  const logger: Logger = {
    level,
    log(messageLevel, ...message) {
      const numeric = lookupLevel(messageLevel);
      if (!(lookupLevel(logger.level) <= numeric)) return;
      const method = methodMap[numeric] ?? "log";
      output[method](...message);
    },
  };
  return logger;
};

/** The logger used when no `logger` runtime option is supplied. */
export const defaultLogger: Logger = createLogger();
