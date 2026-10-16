/**
 * Whitespace control: a port of the Handlebars 4.7 `WhitespaceControl` visitor.
 *
 * The pass edits `ContentStatement.value` in place, never `original`, and
 * records what it removed through `leftStripped` / `rightStripped`. It is
 * meant for ASTs from `parseWithoutProcessing`; `Handlebars.parse` and
 * `@handlebars/parser`'s `parse` have already run their own version of it.
 *
 * @packageDocumentation
 */

import type { ContentStatement, ParserProgram, Program, Statement } from "./types";

/** Options understood by {@link processWhitespace}. */
export interface WhitespaceOptions {
  /** Keep standalone block, partial, comment, and decorator lines. Default `false`. */
  ignoreStandalone?: boolean | undefined;
}

/**
 * What a statement tells its parent program about the whitespace around it.
 * Mirrors the object the 4.7 visitor returns from each node handler.
 */
interface StripInfo {
  /** `{{~` was written: strip everything before the tag. */
  open?: boolean | undefined;
  /** `~}}` was written: strip everything after the tag. */
  close?: boolean | undefined;
  /** The whole tag (partial or comment) may be removed with its line. */
  inlineStandalone?: boolean;
  /** The opening tag of a block may be removed with its line. */
  openStandalone?: boolean;
  /** The closing tag of a block may be removed with its line. */
  closeStandalone?: boolean;
  /** Body right after the opening tag; edited when the opening line is standalone. */
  openBody?: Statement[];
  /** Body right before the closing tag; edited when the closing line is standalone. */
  closeBody?: Statement[];
}

const isContent = (node: Statement | undefined): node is ContentStatement =>
  node?.type === "ContentStatement";

// ---------------------------------------------------------------------------
// Standalone detection: does the content around a position end/start a line?
// ---------------------------------------------------------------------------

/**
 * Whether the content before position `i` (the end of `body` when omitted)
 * ends with a line break followed only by whitespace, so a tag at `i` starts
 * its own line. The first node of the root program also counts when it is
 * whitespace only, because the start of the template acts as a line break.
 *
 * Reads `original`, so earlier stripping does not change the verdict.
 */
const isPrevWhitespace = (body: Statement[], i = body.length, isRoot = false): boolean => {
  const prev = body[i - 1];
  const sibling = body[i - 2];
  if (!prev) return isRoot;
  if (!isContent(prev)) return false;
  return (sibling || !isRoot ? /(?:^|\S)[^\S\n]*\n\s*$/ : /^\s*$|(?:^|\S)[^\S\n]*\n\s*$/).test(
    prev.original,
  );
};

/**
 * Whether the content after position `i` (the start of `body` when omitted)
 * begins with optional whitespace and a line break, so a tag at `i` ends its
 * own line. The last node of the root program also counts when it is
 * whitespace only, because the end of the template acts as a line break.
 */
const isNextWhitespace = (body: Statement[], i = -1, isRoot = false): boolean => {
  const next = body[i + 1];
  const sibling = body[i + 2];
  if (!next) return isRoot;
  if (!isContent(next)) return false;
  return (sibling || !isRoot ? /^\s*?\r?\n/ : /^\s*?(\r?\n|$)/).test(next.original);
};

// ---------------------------------------------------------------------------
// Omit helpers: edit the content node on one side of a position
// ---------------------------------------------------------------------------

/**
 * Removes leading whitespace from the content node after position `i`
 * (the first node when `i` is omitted). Without `multiple`, only one line
 * break and the spaces before it go, and a node is only edited once.
 */
const omitRight = (body: Statement[], i?: number, multiple = false): void => {
  const current = body[i === undefined ? 0 : i + 1];
  if (!isContent(current) || (!multiple && current.rightStripped)) return;

  const original = current.value;
  current.value = current.value.replace(multiple ? /^\s+/ : /^[ \t]*\r?\n?/, "");
  current.rightStripped = current.value !== original;
};

/**
 * Removes trailing whitespace from the content node before position `i`
 * (the last node when `i` is omitted). Without `multiple`, only the spaces
 * and tabs of the final line go, and a node is only edited once.
 *
 * The patterns are anchored after a non-whitespace character (or the start)
 * so a long whitespace run is scanned once rather than quadratically.
 *
 * @returns `true` when this call removed something.
 */
const omitLeft = (body: Statement[], i?: number, multiple = false): boolean => {
  const current = body[i === undefined ? body.length - 1 : i - 1];
  if (!isContent(current) || (!multiple && current.leftStripped)) return false;

  const original = current.value;
  current.value = current.value.replace(multiple ? /(^|\S)\s+$/ : /(^|[^ \t])[ \t]+$/, "$1");
  current.leftStripped = current.value !== original;
  return current.leftStripped;
};

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

/** Any statement with `openStrip` / `closeStrip`: the three block-shaped nodes. */
type BlockLike = Extract<Statement, { openStrip: unknown }>;

/**
 * The program of a block nested in a `chained` inverse. For `{{else if x}}`
 * the parser stores the next block as the only statement of the inverse.
 */
const nestedProgram = (node: Statement | undefined): Program | undefined =>
  node && (node.type === "BlockStatement" || node.type === "DecoratorBlock")
    ? node.program
    : undefined;

/**
 * Resolves the programs that whitespace around a block's `{{else}}` and
 * closing tag refers to. Both are the plain inverse unless it is chained.
 *
 * - `first` is the body right after the first `{{else}}`; for a chain that
 *   is the nested block's own program.
 * - `last` is the body right before the closing tag; for a chain that is
 *   the program of the final block in the chain.
 */
const resolveInverse = (inverse: Program): { first: Program; last: Program } => {
  if (!inverse.chained) return { first: inverse, last: inverse };

  let last = inverse;
  while (last.chained) {
    const nested = nestedProgram(last.body[last.body.length - 1]);
    if (!nested) break;
    last = nested;
  }
  return { first: nestedProgram(inverse.body[0]) ?? inverse, last };
};

/** Handles `BlockStatement`, `DecoratorBlock`, and `PartialBlockStatement`. */
const visitBlock = (block: BlockLike, options: WhitespaceOptions): StripInfo => {
  const program: Program | undefined = "program" in block ? block.program : undefined;
  const inverse: Program | undefined = "inverse" in block ? block.inverse : undefined;
  if (program) visitProgram(program, options, false);
  if (inverse) visitProgram(inverse, options, false);

  const main = program ?? inverse;
  if (!main) return { open: block.openStrip.open, close: block.closeStrip.close };
  // Only an inverse that follows a program is an `{{else}}`; `{{^x}}` has no program.
  const elseProgram = program ? inverse : undefined;
  const { first: firstInverse, last: lastInverse } = elseProgram
    ? resolveInverse(elseProgram)
    : { first: undefined, last: undefined };

  const strip: StripInfo = {
    open: block.openStrip.open,
    close: block.closeStrip.close,
    // Candidacy only: the parent program decides whether the tag's line is
    // actually standalone by looking at the content around the block.
    openStandalone: isNextWhitespace(main.body),
    closeStandalone: isPrevWhitespace((firstInverse ?? main).body),
    openBody: main.body,
    // 4.7 strips the inverse itself here, not the chain's last program, so an
    // indented close tag after `{{else if}}` keeps its indent.
    closeBody: (inverse ?? main).body,
  };

  if (block.openStrip.close) omitRight(main.body, undefined, true);

  if (firstInverse && lastInverse) {
    const inverseStrip = "inverseStrip" in block ? block.inverseStrip : undefined;
    if (inverseStrip?.open) omitLeft(main.body, undefined, true);
    if (inverseStrip?.close) omitRight(firstInverse.body, undefined, true);
    if (block.closeStrip.open) omitLeft(lastInverse.body, undefined, true);

    // A standalone {{else}} loses its line on both sides.
    if (
      !options.ignoreStandalone &&
      isPrevWhitespace(main.body) &&
      isNextWhitespace(firstInverse.body)
    ) {
      omitLeft(main.body);
      omitRight(firstInverse.body);
    }
  } else if (block.closeStrip.open) {
    omitLeft(main.body, undefined, true);
  }

  return strip;
};

/** Captures the indentation of a standalone partial's line from the preceding content. */
const indentOf = (previous: Statement | undefined): string =>
  (isContent(previous) && /(?:^|[^ \t])([ \t]+)$/.exec(previous.original)?.[1]) || "";

/** Returns the strip information for one statement, visiting nested programs first. */
const visitStatement = (node: Statement, options: WhitespaceOptions): StripInfo | undefined => {
  switch (node.type) {
    case "MustacheStatement":
    case "Decorator":
      return node.strip;
    case "PartialStatement":
    case "CommentStatement":
      return { inlineStandalone: true, open: node.strip.open, close: node.strip.close };
    case "BlockStatement":
    case "DecoratorBlock":
    case "PartialBlockStatement":
      return visitBlock(node, options);
    default:
      return undefined;
  }
};

/**
 * Visits each statement of a program, applying tildes and then removing
 * standalone lines. `isRoot` lets the template's edges count as line breaks.
 */
const visitProgram = (program: Program, options: WhitespaceOptions, isRoot: boolean): void => {
  const doStandalone = !options.ignoreStandalone;
  const { body } = program;

  for (let i = 0; i < body.length; i += 1) {
    const current = body[i];
    const strip = current && visitStatement(current, options);
    if (!current || !strip) continue;

    const prevWhitespace = isPrevWhitespace(body, i, isRoot);
    const nextWhitespace = isNextWhitespace(body, i, isRoot);
    const openStandalone = strip.openStandalone && prevWhitespace;
    const closeStandalone = strip.closeStandalone && nextWhitespace;
    const inlineStandalone = strip.inlineStandalone && prevWhitespace && nextWhitespace;

    if (strip.close) omitRight(body, i, true);
    if (strip.open) omitLeft(body, i, true);

    if (doStandalone && inlineStandalone) {
      omitRight(body, i);
      if (omitLeft(body, i) && current.type === "PartialStatement") {
        current.indent = indentOf(body[i - 1]);
      }
    }

    if (doStandalone && openStandalone && strip.openBody) {
      omitRight(strip.openBody);
      omitLeft(body, i);
    }

    if (doStandalone && closeStandalone && strip.closeBody) {
      omitRight(body, i);
      omitLeft(strip.closeBody);
    }
  }
};

const processed = new WeakSet<object>();

/**
 * Applies Handlebars 4.7 whitespace control to an unprocessed AST, in place.
 *
 * - `{{~` and `~}}` remove all whitespace on that side of the tag.
 * - Block, partial, comment, and decorator tags that are alone on a line
 *   lose the whole line, unless `ignoreStandalone` is set.
 * - A standalone partial records its line's indentation in `indent`.
 *
 * Only `ContentStatement.value`, `leftStripped`, `rightStripped`, and
 * `PartialStatement.indent` are written. Each program object is processed
 * once: later calls return immediately, whatever options they pass.
 *
 * @param program - The root program, typically from `parseWithoutProcessing`.
 * @param options - Standalone handling.
 * @returns The same `program`, for chaining.
 *
 * @example
 * ```ts
 * const ast = processWhitespace(parseWithoutProcessing("  {{> item}}\n"));
 * // ast.body[1].indent === "  ", ast.body[0].value === ""
 * ```
 */
export const processWhitespace = <T extends ParserProgram>(
  program: T,
  options: WhitespaceOptions = {},
): T => {
  if (processed.has(program)) return program;
  processed.add(program);
  visitProgram(program as unknown as Program, options, true);
  return program;
};
