import { describe, expect, it } from "vitest";
import { ensureCodexHooksEnabled, ensureHermesHooksConfig, removeHermesHooksConfig } from "./setup.js";

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
