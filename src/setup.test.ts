import { describe, expect, it } from "vitest";
import { ensureCodexHooksEnabled } from "./setup.js";

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
