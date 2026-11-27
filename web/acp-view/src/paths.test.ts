import { describe, expect, it } from "vitest";
import { linksAsWord, pathTokens, rehypePathRefs, rehypeTaskRefs, taskTokens, workFolders } from "./paths";
import type { ToolCall } from "./session-state";

const tokens = (text: string) => pathTokens(text).map((token) => token.token);

describe("paths in prose", () => {
  it("finds paths, files with an extension, lines and pane ids as the terminal does", () => {
    expect(tokens("I moved what I know to CONTEXT.md, MEMORY.md and OVERVIEW.md in ~/.agents/programs/agents-app/.")).toEqual(
      ["CONTEXT.md", "MEMORY.md", "OVERVIEW.md", "~/.agents/programs/agents-app/"]);
    expect(tokens("See src/main.tsx:42 and web/view.css:3:7, then pane %12.")).toEqual(["src/main.tsx:42", "web/view.css:3:7", "%12"]);
  });

  it("leaves out sentences, numbers, URLs and percentages", () => {
    expect(tokens("It took 1.5 s and 50% of the time, version 2.7.1.")).toEqual([]);
    expect(tokens("Read https://example.com/docs/a.md first.")).toEqual([]);
  });

  it("marks them in the prose, not in code or links", () => {
    const tree = { type: "root", children: [
      { type: "element", tagName: "p", children: [{ type: "text", value: "Open README.md now" }] },
      { type: "element", tagName: "code", children: [{ type: "text", value: "skip.md" }] },
      { type: "element", tagName: "a", children: [{ type: "text", value: "link.md" }] },
    ] };
    rehypePathRefs()(tree as never);
    const p = tree.children[0] as { children: Array<{ type: string; value?: string; properties?: Record<string, unknown> }> };
    expect(p.children.map((child) => child.value ?? child.properties?.dataPathRef)).toEqual(["Open ", "README.md", " now"]);
    expect((tree.children[1] as { children: unknown[] }).children).toHaveLength(1);
    expect((tree.children[2] as { children: unknown[] }).children).toHaveLength(1);
  });
});

describe("the folders the agent worked in", () => {
  const call = (id: string, rawInput: unknown, paths: string[] = [], diff?: string): ToolCall => ({
    id, title: id, status: "completed", rawInput,
    locations: paths.map((path) => ({ path })),
    content: diff ? [{ type: "diff", path: diff, oldText: "", newText: "x" }] : [],
  });

  it("are where its tools' files are and where its commands ran, the latest first", () => {
    expect(workFolders([
      call("read", {}, ["/code/agents/src/acp-peek.ts"]),
      call("edit", {}, [], "/code/agents-app-wt/AgentsNext/UI/Links.swift"),
      call("bash", { command: "cd /code/other && git status" }),
      call("codex", { command: ["bash", "-lc", "ls"], cwd: "/code/fourth/" }),
      call("again", {}, ["/code/agents/src/acp-host.ts"]),
      call("relative", { command: "cd src && ls" }, ["notes.md"]),
    ])).toEqual(["/code/agents/src", "/code/fourth", "/code/other", "/code/agents-app-wt/AgentsNext/UI"]);
  });

  it("keeps the latest twenty", () => {
    const calls = Array.from({ length: 30 }, (_, index) => call(`c${index}`, {}, [`/code/r${index}/a.ts`]));
    const folders = workFolders(calls);
    expect(folders).toHaveLength(20);
    expect(folders[0]).toBe("/code/r29");
  });
});

describe("task names in prose", () => {
  const tasks = new Set(["wi01-dts", "wi07a-brandgate", "docs"]);
  const found = (text: string) => taskTokens(text, tasks).map((token) => token.token);

  it("finds a task name as a whole word", () => {
    expect(found("- wi01-dts: item-creation-service #3 merged; wi07a-brandgate asks you.")).toEqual(["wi01-dts", "wi07a-brandgate"]);
  });

  it("leaves names inside paths and longer names", () => {
    expect(found("see notes/wi01-dts.md and wi01-dts-old, xwi01-dts")).toEqual([]);
  });

  it("links a one-word task only in backticks", () => {
    expect(linksAsWord("docs")).toBe(false);
    expect(linksAsWord("wi01-dts")).toBe(true);
    const tree = { type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value: "docs and wi01-dts" }] }] };
    rehypeTaskRefs([...tasks])()(tree as never);
    const p = tree.children[0] as { children: Array<{ value?: string; properties?: Record<string, unknown> }> };
    expect(p.children.map((child) => child.value ?? child.properties?.dataPathRef)).toEqual(["docs and ", "wi01-dts"]);
  });
});
