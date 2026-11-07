import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeLine } from "./blocks";

describe("paths in code", () => {
  it("wraps a path that exists across the highlighter's tokens, line included, and leaves the rest", () => {
    const found = new Map([["src/main.ts:4", { kind: "file" as const, path: "/code/app/src/main.ts", rel: "src/main.ts", line: 4 }], ["gone.ts", null]]);
    const html = renderToStaticMarkup(createElement(CodeLine, { tokens: [{ content: "open src/", color: "#111" }, { content: "main.ts:4 and gone.ts" }], found, host: null }));
    expect(html).toBe(
      '<span style="--c:#111">open </span>'
      + '<span class="cpath" role="link" title="Click: open beside · ⌘-click: open in the editor" data-path="/code/app/src/main.ts:4"><span style="--c:#111">src/</span><span>main.ts:4</span></span>'
      + "<span> and gone.ts</span>",
    );
  });

  it("renders a line with no paths as its tokens", () => {
    expect(renderToStaticMarkup(createElement(CodeLine, { tokens: [{ content: "let x = 1;" }], found: new Map(), host: null }))).toBe("<span>let x = 1;</span>");
  });
});
