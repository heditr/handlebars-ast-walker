import { describe, expect, test } from "vitest";
import Handlebars from "handlebars";

import { SafeString, escapeExpression } from "../src/escape";

describe("escapeExpression", () => {
  test("given a string containing every HTML special character, should escape each one the way Handlebars does", () => {
    const input = `&<>"'\`=`;

    expect(escapeExpression(input)).toBe("&amp;&lt;&gt;&quot;&#x27;&#x60;&#x3D;");
    expect(escapeExpression(input)).toBe(Handlebars.escapeExpression(input));
  });

  test("given a string with no special characters, should return the same string instance", () => {
    const input = "plain text 123";

    expect(escapeExpression(input)).toBe(input);
  });

  test("given a string with special characters among plain text, should escape only the special characters", () => {
    expect(escapeExpression('a < b && c = "d"')).toBe(
      "a &lt; b &amp;&amp; c &#x3D; &quot;d&quot;",
    );
  });

  test("given null or undefined, should render nothing", () => {
    expect(escapeExpression(null)).toBe("");
    expect(escapeExpression(undefined)).toBe("");
  });

  test("given falsy primitives other than null, should stringify them instead of dropping them", () => {
    expect(escapeExpression(0)).toBe("0");
    expect(escapeExpression(false)).toBe("false");
    expect(escapeExpression(Number.NaN)).toBe("NaN");
  });

  test("given a number or boolean, should stringify it", () => {
    expect(escapeExpression(42)).toBe("42");
    expect(escapeExpression(true)).toBe("true");
  });

  test("given an object whose toString contains markup, should escape the stringified form", () => {
    const value = { toString: () => "<b>" };

    expect(escapeExpression(value)).toBe("&lt;b&gt;");
  });

  test("given a SafeString, should return its content unescaped", () => {
    const html = "<b>bold</b>";

    expect(escapeExpression(new SafeString(html))).toBe(html);
  });

  test("given a plain object with a toHTML method, should trust it like Handlebars does", () => {
    const value = { toHTML: () => "<i>raw</i>" };

    expect(escapeExpression(value)).toBe("<i>raw</i>");
  });

  test("given an object whose toHTML property is not a function, should escape it as an ordinary value", () => {
    const value = { toHTML: "<nope>", toString: () => "<x>" };

    expect(escapeExpression(value)).toBe("&lt;x&gt;");
  });

  test("given a Handlebars SafeString from the official runtime, should interoperate through toHTML", () => {
    const value = new Handlebars.SafeString("<hr>");

    expect(escapeExpression(value)).toBe("<hr>");
  });
});

describe("SafeString", () => {
  test("given wrapped markup, should expose it through toString and toHTML", () => {
    const safe = new SafeString("<p>hi</p>");

    expect(safe.toString()).toBe("<p>hi</p>");
    expect(safe.toHTML()).toBe("<p>hi</p>");
  });

  test("given string concatenation, should coerce to the wrapped markup", () => {
    const safe = new SafeString("<p>hi</p>");

    expect(`${safe}`).toBe("<p>hi</p>");
    expect("x" + safe).toBe("x<p>hi</p>");
  });

  test("given a nested SafeString, should flatten to the inner markup", () => {
    const inner = new SafeString("<em>in</em>");

    expect(new SafeString(inner.toString()).toHTML()).toBe("<em>in</em>");
  });
});
