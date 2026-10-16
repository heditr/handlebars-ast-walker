/**
 * Built-in decorators ported from Handlebars 4.7.10. Only `inline` ships
 * with Handlebars; it backs `{{#*inline "name"}}...{{/inline}}`.
 *
 * @packageDocumentation
 */

import type { BlockRenderer, DecoratorDelegate, DecoratorMap } from "./types";

/** The `props` bag `inline` shares with other decorators on the same program. */
interface InlineProps {
  partials?: Record<string, BlockRenderer>;
}

/**
 * `{{#*inline "name"}}body{{/inline}}`: registers `body` as a partial for
 * the duration of the program the block appears in.
 *
 * The first `inline` on a program wraps its renderer so that, while the
 * program renders, `container.partials` is a copy of the current partials
 * extended with every inline partial declared on that program. The map is
 * restored afterwards, so inline partials never leak out of their block and
 * never mutate the registry the environment owns. Later `inline` calls on
 * the same program only add to the shared `props.partials` record.
 *
 * Because decorators run when a program's renderer is created, an inline
 * partial is visible to the whole program, including calls that precede the
 * declaration in the source.
 *
 * @example
 * ```hbs
 * {{#*inline "row"}}<li>{{this}}</li>{{/inline}}
 * {{#each items}}{{> row}}{{/each}}
 * ```
 */
export const inlineDecorator: DecoratorDelegate = (fn, props: InlineProps, container, options) => {
  let wrapped: BlockRenderer = fn;
  if (props.partials === undefined) {
    const declared: Record<string, BlockRenderer> = {};
    props.partials = declared;
    wrapped = (context, blockOptions) => {
      const original = container.partials;
      container.partials = { ...original, ...declared };
      try {
        return fn(context, blockOptions);
      } finally {
        container.partials = original;
      }
    };
  }
  if (options.fn !== undefined) props.partials[String(options.args[0])] = options.fn;
  return wrapped;
};

/**
 * Builds a fresh registry of the built-in decorators. A new object is
 * returned on every call so one render cannot affect another.
 *
 * @returns A {@link DecoratorMap} containing `inline`.
 */
export const createBuiltinDecorators = (): DecoratorMap => ({ inline: inlineDecorator });
