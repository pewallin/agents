import { describe, expect, it } from "vitest";
import { ensureCodexHooksEnabled, ensureHermesHooksConfig, jsonInStyleOf, removeCodexHooksFlag, removeHermesHooksConfig } from "./setup.js";

describe("ensureCodexHooksEnabled", () => {
  it("migrates deprecated codex_hooks to hooks", () => {
    const result = ensureCodexHooksEnabled([
      "[features]",
      "codex_hooks = true",
      "terminal_resize_reflow = true",
      "",
    ].join("\n"));

    expect(result.changed).toBe(true);
    expect(result.text).toContain("hooks = true");
    expect(result.text).not.toContain("codex_hooks");
    expect(result.text).toContain("terminal_resize_reflow = true");
  });

  it("does not duplicate an existing hooks flag", () => {
    const result = ensureCodexHooksEnabled([
      "[features]",
      "codex_hooks = true",
      "hooks = true",
      "",
    ].join("\n"));

    expect(result.changed).toBe(true);
    expect(result.text.match(/^hooks = true$/gm)).toHaveLength(1);
    expect(result.text).not.toContain("codex_hooks");
  });
});

describe("ensureHermesHooksConfig", () => {
  it("replaces an empty hooks map with Hermes reporting hooks", () => {
    const result = ensureHermesHooksConfig([
      "model:",
      "  default: gpt-5.5",
      "hooks: {}",
      "hooks_auto_accept: false",
      "",
    ].join("\n"));

    expect(result.changed).toBe(true);
    expect(result.text).toContain("hooks:\n  on_session_start:");
    expect(result.text).toContain("extensions/hermes/report-state.sh");
    expect(result.text).toContain("hooks_auto_accept: false");
  });

  it("preserves unrelated hooks and removes Hermes hooks cleanly", () => {
    const installed = ensureHermesHooksConfig([
      "hooks:",
      "  pre_tool_call:",
      "    - command: \"/tmp/user-hook.sh\"",
      "      timeout: 20",
      "logging:",
      "  level: INFO",
      "",
    ].join("\n"));
    const removed = removeHermesHooksConfig(installed.text);

    expect(removed.text).toContain("command: \"/tmp/user-hook.sh\"");
    expect(removed.text).not.toContain("extensions/hermes/report-state.sh");
    expect(removed.text).toContain("logging:");
  });
});

describe("removeCodexHooksFlag", () => {
  it("takes back the flag and the [features] table setup added", () => {
    const original = "model = \"gpt-5.5\"\n";
    const installed = ensureCodexHooksEnabled(original).text;
    expect(installed).toContain("hooks = true # added by agents setup");
    expect(ensureCodexHooksEnabled(installed).changed).toBe(false);

    expect(removeCodexHooksFlag(installed)).toEqual({ text: original, changed: true });
  });

  it("keeps a [features] table with other flags and tables after it", () => {
    const original = "[features]\nterminal_resize_reflow = true\n\n[tui]\ntheme = \"dark\"\n";
    const installed = ensureCodexHooksEnabled(original).text;

    expect(removeCodexHooksFlag(installed).text).toBe(original);
  });

  it("drops an empty [features] table between other tables", () => {
    const installed = "[tui]\ntheme = \"dark\"\n\n[features]\nhooks = true # added by agents setup\n\n[mcp]\nx = 1\n";

    expect(removeCodexHooksFlag(installed).text).toBe("[tui]\ntheme = \"dark\"\n\n[mcp]\nx = 1\n");
  });

  it("leaves a hooks flag the user set", () => {
    const config = "[features]\nhooks = true\n";

    expect(removeCodexHooksFlag(config)).toEqual({ text: config, changed: false });
  });
});

describe("jsonInStyleOf", () => {
  it("keeps the file's indentation and final newline", () => {
    expect(jsonInStyleOf({ a: { b: 1 } }, "{\n    \"x\": 1\n}")).toBe("{\n    \"a\": {\n        \"b\": 1\n    }\n}");
    expect(jsonInStyleOf({ a: 1 }, "{\n\t\"x\": 1\n}\n")).toBe("{\n\t\"a\": 1\n}\n");
    expect(jsonInStyleOf({ a: 1 }, "")).toBe("{\n  \"a\": 1\n}\n");
  });
});
