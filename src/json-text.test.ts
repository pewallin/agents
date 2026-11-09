import { describe, expect, it } from "vitest";
import { appendElement, insertMember, removeElement, removeMember } from "./json-text.js";

describe("JSON text edits", () => {
  const cases: Array<[string, string[]]> = [
    ["{}\n", ["mcpServers"]],
    ['{\n    "theme": "dark"\n}\n', ["mcpServers"]],
    ['{"a": 1, "mcpServers": {"x": {"command": "y"}}}', ["mcpServers"]],
    ['{\n  "mcpServers": {}\n}\n', ["mcpServers"]],
    ['{\n\t"mcpServers": {\n\t\t"x": { "args": ["--a", "--b"] }\n\t}\n}\n', ["mcpServers"]],
  ];
  it.each(cases)("puts a member in and takes it back out byte for byte: %j", (text, path) => {
    const inserted = insertMember(text, path, "agents", { command: "/x", args: ["mcp"] });
    expect(JSON.parse(inserted).mcpServers.agents).toEqual({ command: "/x", args: ["mcp"] });
    const removed = removeMember(inserted, path, "agents");
    const created = JSON.parse(text).mcpServers === undefined;
    expect(created ? removeMember(removed, [], "mcpServers") : removed).toBe(text);
  });

  it("keeps the file's own indentation for what it adds", () => {
    const text = '{\n\t"mcpServers": {\n\t\t"x": {}\n\t}\n}\n';
    expect(insertMember(text, ["mcpServers"], "agents", { a: 1 })).toBe('{\n\t"mcpServers": {\n\t\t"x": {},\n\t\t"agents": {\n\t\t\t"a": 1\n\t\t}\n\t}\n}\n');
  });

  it("takes out the first of several members, and an element from inline and broken arrays", () => {
    expect(removeMember('{\n  "agents": 1,\n  "b": 2\n}', [], "agents")).toBe('{\n  "b": 2\n}');
    const inline = '{"allow": ["a", "b"]}';
    expect(removeElement(appendElement(inline, ["allow"], "mcp__agents"), ["allow"], "mcp__agents")).toBe(inline);
    const broken = '{\n  "allow": [\n    "a"\n  ]\n}\n';
    expect(appendElement(broken, ["allow"], "z")).toBe('{\n  "allow": [\n    "a",\n    "z"\n  ]\n}\n');
    expect(removeElement(appendElement(broken, ["allow"], "z"), ["allow"], "z")).toBe(broken);
  });
});
