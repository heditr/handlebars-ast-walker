# handlebars-ast-walker

A CSP-safe [Handlebars](https://handlebarsjs.com) 4.7 interpreter. It renders a
pre-parsed Handlebars AST by walking it; it never generates JavaScript, so it
runs under a Content Security Policy that forbids `unsafe-eval`.

- Zero runtime dependencies. `@handlebars/parser` is an optional peer, used only
  if you want the walker to parse string partials for you.
- Dual ESM / CJS build with TypeScript declarations.
- Output is checked against `handlebars@4.7` in the test suite: interpolation and
  escaping, paths, every built-in helper, sub-expressions and hashes, partials,
  decorators and inline partials, whitespace control, and prototype-access rules.

## Install

```sh
npm install handlebars-ast-walker @handlebars/parser
```

`@handlebars/parser` is the parser Handlebars itself uses, split out as its own
package. Any parser that produces the same AST shape works; the parser is only
needed where templates are turned into ASTs.

## Quick start

```ts
import { parseWithoutProcessing } from "@handlebars/parser";
import { renderAST } from "handlebars-ast-walker";

const ast = parseWithoutProcessing("Hello {{name}}! {{#each items}}<li>{{this}}</li>{{/each}}");

renderAST(ast, { name: "Ada", items: ["a", "b"] });
// "Hello Ada! <li>a</li><li>b</li>"
```

Use `parseWithoutProcessing`, not `parse`. See [The unprocessed-AST contract](#the-unprocessed-ast-contract).

## CSP

Rendering never calls `eval`, `new Function`, or a string-based timer. A test
scans `src/**/*.ts` for those constructs, and another renders templates with
`globalThis.eval` and `globalThis.Function` replaced by throwing stubs. The
parser (`@handlebars/parser`) is a plain Jison-generated LALR parser and is
likewise CSP-safe.

This is the intended deployment shape:

- **Build time or server:** parse templates with `@handlebars/parser` and ship
  the JSON AST, or ship template source alongside the parser.
- **Browser or sandbox with a strict CSP:** `compileAST` the AST and render.

## API

### `createEnvironment(options?)`

The walker's `Handlebars.create()`. Holds helpers, partials, decorators, a
logger, default runtime options, and an optional `parse` function.

```ts
import { parseWithoutProcessing } from "@handlebars/parser";
import { createEnvironment, compileAST, SafeString } from "handlebars-ast-walker";

const env = createEnvironment({
  parse: parseWithoutProcessing, // lets registerPartial accept template strings
  noEscape: false,               // any RuntimeOptions field becomes a default
});

env.registerHelper("upper", (text: unknown) => String(text).toUpperCase());
env.registerPartial("row", "<li>{{upper this}}</li>");

const template = compileAST(parseWithoutProcessing("<ul>{{#each items}}{{> row}}{{/each}}</ul>"), env);
template({ items: ["a", "b"] }); // "<ul><li>A</li><li>B</li></ul>"
```

Methods: `registerHelper`, `unregisterHelper`, `registerPartial`,
`unregisterPartial`, `registerDecorator`, `unregisterDecorator`. Each
`register*` accepts `(name, value)` or a map. Registries are read at render
time, so registering after `compileAST` still takes effect.

### `compileAST(ast, env?)`

Returns a `TemplateDelegate`: `(context?, runtimeOptions?) => string`. Nothing
is generated; every call walks the AST. Render-time options override the
environment's defaults for that call only.

### `renderAST(ast, context?, options?)`

One-shot render with no environment. `options` accepts everything
`createEnvironment` does, including `helpers`, `partials`, `decorators`, and
`parse`.

### Helpers

Helpers are variadic. Positional arguments come first; the last argument is
always `HelperOptions`, and `this` is the current context.

```ts
interface HelperOptions {
  name: string;
  hash: Record<string, unknown>;
  data: DataFrame | undefined;        // @index, @key, @root, ...
  loc: SourceLocation | undefined;
  lookupProperty: (parent: unknown, propertyName: string) => unknown;
  fn: (context?: unknown, options?: BlockOptions) => string;
  inverse: (context?: unknown, options?: BlockOptions) => string;
}
```

`fn` and `inverse` accept `{ data, blockParams }` like Handlebars. Use
`options.lookupProperty` instead of indexing objects directly so the
prototype-access rules below apply to your helper too.

```ts
env.registerHelper("link", function (this: unknown, text: string, options) {
  const href = Utils.escapeExpression(options.hash.href);
  return new SafeString(`<a href="${href}">${Utils.escapeExpression(text)}</a>`);
});
```

### Partials

`registerPartial` accepts a parsed program, template source (requires `parse`),
or a function `(context, options) => string`. String partials are parsed once
per render. Dynamic partials (`{{> (lookup . "name")}}`), partial blocks
(`{{#> layout}}...{{/layout}}` with `@partial-block`), inline partials
(`{{#*inline "name"}}`), hash contexts, standalone indentation, and
`explicitPartialContext` behave as in Handlebars 4.7.

### `SafeString` and `Utils`

`new SafeString(html)` marks a value as already escaped. `Utils` exposes
`escapeExpression`, `isEmpty`, and `createFrame` with the same semantics as
`Handlebars.Utils` / `Handlebars.createFrame`.

### Errors

Template failures throw `HandlebarsRuntimeError` with a stable `code`:
`missing-property` (strict mode), `missing-helper`, `unknown-helper`
(`knownHelpersOnly`), `missing-partial`, `invalid-partial`,
`missing-decorator`, `invalid-arguments`, `unknown-node`, `invalid-program`.
`isRuntimeError(error)` is the type guard; `error.loc` carries the node's
source location when the AST has one.

### Logging

`createEnvironment({ logger })` or a render-time `logger` receives `{{log}}`
output and prototype-access warnings. `createLogger({ level, output })` builds
one that writes to `console` by default; `logger.level` is mutable like
`Handlebars.logger.level`.

## Runtime options

Settable on the environment and overridable per render.

| Option | Default | Meaning |
| --- | --- | --- |
| `strict` | `false` | Throw `missing-property` when a path is missing. |
| `compat` | `false` | Mustache-style recursive lookup through parent contexts. |
| `data` | `true` | `false` disables `@data`; an object seeds the root data frame. |
| `noEscape` | `false` | Skip HTML escaping for `{{expr}}`. |
| `preventIndent` | `false` | Do not re-indent standalone partial output. |
| `explicitPartialContext` | `false` | Partials get no context unless one is passed. |
| `knownHelpersOnly` | `false` | Throw `unknown-helper` for helper-shaped calls to unregistered names. |
| `processWhitespace` | `true` | Run the whitespace-control pass; set `false` for already-processed ASTs. |
| `ignoreStandalone` | `false` | Keep standalone block and comment lines. |
| `allowProtoPropertiesByDefault` | `false` | Allow reading inherited non-function properties. |
| `allowProtoMethodsByDefault` | `false` | Allow reading inherited methods. |
| `allowedProtoProperties` | `{}` | Per-name overrides for inherited properties. |
| `allowedProtoMethods` | `{}` | Per-name overrides for inherited methods. |

## Security

Property access follows Handlebars 4.6+ rules:

- Own properties are readable. Inherited properties are blocked unless
  whitelisted through the `allowProto*` options.
- `__proto__`, `constructor`, `__defineGetter__`, `__defineSetter__`,
  `__lookupGetter__`, and `__lookupSetter__` are blocked even when inherited
  access is allowed by default; only a per-name `allowed*` entry opens them.
- `constructor` on a prototype object (where `parent === value.prototype`) is
  blocked even though it is an own property.
- Denied access is logged once per property name through the logger.

The same `lookupProperty` serves mustaches, block heads, `lookup`, `each`,
`with`, partial contexts, and helpers that use `options.lookupProperty`.

Templates are code: only render templates you trust. The walker constrains what
a template can reach in the context, not what registered helpers can do.

## The unprocessed-AST contract

`compileAST` and `renderAST` expect an **unprocessed** program, the output of
`parseWithoutProcessing`. The walker runs the Handlebars 4.7 `WhitespaceControl`
pass itself: it mutates `ContentStatement.value` in place (leaving `original`
intact), records the program in a `WeakSet`, and never processes it twice, so a
compiled template can be rendered any number of times.

`Handlebars.parse` and `@handlebars/parser`'s `parse` already run that pass. If
you render one of those ASTs, pass `processWhitespace: false` or standalone
lines and `~` will be stripped a second time. `processWhitespace(program)` is
also exported for callers who want the pass without rendering.

## Benchmark

`npm run bench` builds `dist/` and runs [`bench/render.mts`](bench/render.mts):
a list page with `#each`, `#if`/`else`, a partial, two helpers, and escaping,
rendered against 50 items (~5.5 KB of output) through `Handlebars.compile` and
through `compileAST`. Both engines produce identical output; the script refuses
to report otherwise.

Measured on Node v24.22.0, arm64 macOS, median of 7 rounds × 5,000 renders
after 2,000 warm-up renders; compile is the median of 200 compile + first-render
samples:

| engine | compile + first render | renders / s | µs / render |
| --- | ---: | ---: | ---: |
| handlebars 4.7 (compile) | 0.585 ms | 12,850 | 77.8 |
| handlebars-ast-walker (compileAST) | 0.284 ms | 5,651 | 177.0 |

Interpreting the AST is roughly half the throughput of Handlebars' generated
functions on this fixture, and starts faster because there is no code
generation step. Numbers vary between runs and machines; run the script
yourself before relying on them.

## Scope

Conformance target is Handlebars 4.7 runtime behaviour for every parser node:
mustaches, blocks (including `{{else if}}` chains and `as |block params|`),
sub-expressions, hashes, partials and partial blocks, decorators and inline
partials, comments, raw blocks, whitespace control, `@data` variables, strict
and compat modes, and prototype-access control. Precompiler output, `Handlebars.template`
spec objects, and `Handlebars.compile`'s source-level options are out of scope.

## Development

```sh
npm test        # vitest, includes the Handlebars 4.7 parity suites
npm run typecheck
npm run build   # tsup: ESM + CJS + .d.ts
npm run bench
```

## License

MIT
