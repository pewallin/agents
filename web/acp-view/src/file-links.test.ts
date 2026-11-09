import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./markdown";
import { linkedPath, rehypeFileLinks } from "./paths";

describe("links to files in the agent's text", () => {
  it("knows a file from its address", () => {
    expect(linkedPath("vuln-jira-triage/report.md")).toBe("vuln-jira-triage/report.md");
    expect(linkedPath("/Users/p/notes%20old.md")).toBe("/Users/p/notes old.md");
    expect(linkedPath("file:///Users/p/a%20b.md")).toBe("/Users/p/a b.md");
    expect(linkedPath("~/notes.md")).toBe("~/notes.md");
    for (const href of ["https://example.com/x.md", "#top", "//cdn.example.com/x", "mailto:a@b.c", "javascript:alert(1)", "file:///", ""]) {
      expect(linkedPath(href)).toBeUndefined();
    }
  });

  it("turns a link to a file into its chip's mark, with the link's text", () => {
    const tree = { type: "root", children: [{ type: "element", tagName: "p", children: [
      { type: "element", tagName: "a", properties: { href: "docs/report.md" }, children: [{ type: "text", value: "the report" }] },
      { type: "element", tagName: "a", properties: { href: "https://example.com" }, children: [{ type: "text", value: "web" }] },
    ] }] };
    rehypeFileLinks()(tree);
    expect(tree.children[0].children).toEqual([
      { type: "element", tagName: "span", properties: { dataPathRef: "docs/report.md", dataPathLink: "true" }, children: [{ type: "text", value: "the report" }] },
      { type: "element", tagName: "a", properties: { href: "https://example.com" }, children: [{ type: "text", value: "web" }] },
    ]);
  });

  it("shows them where the link filter said [blocked], and still blocks a script", () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: "- [Ariels lista (vuln-jira-triage)](vuln-jira-triage/report.md)\n- [TH-3826](file:///Users/p/th3826/report.md)\n- [site](https://example.com)\n- [bad](javascript:alert(1))",
      streaming: false,
    }));
    expect(html).toContain("Ariels lista (vuln-jira-triage)");
    expect(html).toContain("TH-3826");
    expect(html).toContain('data-path="https://example.com/"');
    expect(html.match(/\[blocked\]/g)).toHaveLength(1);
    expect(html).not.toContain("javascript:");
  });
});
