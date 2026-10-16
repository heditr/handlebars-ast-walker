/**
 * Renders the same template through `Handlebars.compile` and through this
 * package's `compileAST`, and reports compile time and render throughput.
 *
 * Run with `npm run bench`, which builds `dist/` first so the numbers come
 * from the published artifact rather than the TypeScript sources. Node 22.6
 * or later is required for its built-in type stripping.
 */

import { performance } from "node:perf_hooks";
import Handlebars from "handlebars";
import { parseWithoutProcessing } from "@handlebars/parser";

import { compileAST, createEnvironment } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Fixture: a list page with blocks, a partial, a helper, and escaping
// ---------------------------------------------------------------------------

const template = `<h1>{{title}}</h1>
<ul>
{{#each items}}
  {{> row}}
{{else}}
  <li>empty</li>
{{/each}}
</ul>
<p>{{count items}} items, rendered for {{#if user}}{{user.name}}{{else}}a guest{{/if}}.</p>
`;

const rowPartial = `<li class="{{#if @first}}first{{/if}}{{#if @last}} last{{/if}}">
  {{@index}}: {{upper name}} &mdash; {{description}}
</li>
`;

const context = {
  title: "Benchmark <fixture>",
  user: { name: "Ada & Co." },
  items: Array.from({ length: 50 }, (_, index) => ({
    name: `item ${index}`,
    description: `Description #${index} with <markup> & "quotes"`,
  })),
};

const helpers = {
  upper: (value: unknown) => String(value).toUpperCase(),
  count: (value: unknown) => (Array.isArray(value) ? value.length : 0),
};

// ---------------------------------------------------------------------------
// Engines under test
// ---------------------------------------------------------------------------

interface Engine {
  readonly name: string;
  /** Compiles the template and renders it once, so lazy compilation is included. */
  compileAndRender(): () => string;
}

const handlebarsEngine: Engine = {
  name: "handlebars 4.7 (compile)",
  compileAndRender() {
    const hb = Handlebars.create();
    hb.registerHelper(helpers);
    hb.registerPartial("row", rowPartial);
    const compiled = hb.compile(template);
    compiled(context);
    return () => compiled(context);
  },
};

const walkerEngine: Engine = {
  name: "handlebars-ast-walker (compileAST)",
  compileAndRender() {
    const env = createEnvironment({ parse: parseWithoutProcessing, helpers });
    env.registerPartial("row", rowPartial);
    const compiled = compileAST(parseWithoutProcessing(template), env);
    compiled(context);
    return () => compiled(context);
  },
};

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const WARMUP_RENDERS = 2_000;
const ROUNDS = 7;
const RENDERS_PER_ROUND = 5_000;
const COMPILE_SAMPLES = 200;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

interface Result {
  readonly name: string;
  readonly compileMs: number;
  readonly rendersPerSecond: number;
  readonly microsecondsPerRender: number;
  readonly output: string;
}

const measure = (engine: Engine): Result => {
  const compileSamples: number[] = [];
  let render = engine.compileAndRender();
  for (let i = 0; i < COMPILE_SAMPLES; i += 1) {
    const start = performance.now();
    render = engine.compileAndRender();
    compileSamples.push(performance.now() - start);
  }

  for (let i = 0; i < WARMUP_RENDERS; i += 1) render();

  const roundRates: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    for (let i = 0; i < RENDERS_PER_ROUND; i += 1) render();
    const elapsedMs = performance.now() - start;
    roundRates.push((RENDERS_PER_ROUND / elapsedMs) * 1000);
  }

  const rendersPerSecond = median(roundRates);
  return {
    name: engine.name,
    compileMs: median(compileSamples),
    rendersPerSecond,
    microsecondsPerRender: 1_000_000 / rendersPerSecond,
    output: render(),
  };
};

const results = [handlebarsEngine, walkerEngine].map(measure);

const [reference, candidate] = results;
if (reference === undefined || candidate === undefined) throw new Error("expected two results");
if (reference.output !== candidate.output) {
  throw new Error("Engines disagree on output; refusing to report numbers for different work.");
}

const format = (n: number, digits = 0): string => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

console.log(`node ${process.version}, ${process.arch}, ${process.platform}`);
console.log(`template: ${template.length} chars, partial: ${rowPartial.length} chars, ${context.items.length} items, output: ${reference.output.length} chars`);
console.log(`median of ${ROUNDS} rounds x ${format(RENDERS_PER_ROUND)} renders after ${format(WARMUP_RENDERS)} warm-up renders; compile is the median of ${COMPILE_SAMPLES} compile+first-render samples`);
console.log("");
console.log("| engine | compile + first render | renders / s | µs / render |");
console.log("| --- | ---: | ---: | ---: |");
for (const result of results) {
  console.log(`| ${result.name} | ${format(result.compileMs, 3)} ms | ${format(result.rendersPerSecond)} | ${format(result.microsecondsPerRender, 1)} |`);
}
console.log("");
console.log(`render throughput: walker runs at ${format((candidate.rendersPerSecond / reference.rendersPerSecond) * 100)}% of Handlebars`);
console.log(`compile + first render: walker takes ${format((candidate.compileMs / reference.compileMs) * 100)}% of Handlebars' time`);
