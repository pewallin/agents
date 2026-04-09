import { describe, expect, it } from "vitest";
import { createStateSnapshot } from "./state.js";
import { isHookAuthoritativeAgent, mergedContextTokens, resolveModelInfo } from "./scanner-state-runtime.js";

describe("hook-authoritative runtime metadata", () => {
  it("treats supported agents as hook authoritative", () => {
    expect(isHookAuthoritativeAgent("codex")).toBe(true);
    expect(isHookAuthoritativeAgent("claude")).toBe(true);
    expect(isHookAuthoritativeAgent("shell")).toBe(false);
  });

  it("does not infer model metadata from pane content for supported agents", () => {
    const snapshot = createStateSnapshot(
      [{ agent: "codex", session: "%1", state: "working", ts: 100 }],
      [],
    );

    const content = [
      "• Done",
      "",
      "gpt-5.2-codex high · 69% left · ~/code/agents-app",
    ].join("\n");

    expect(resolveModelInfo("codex", "%1", content, snapshot)).toEqual({});
  });

  it("does not infer context usage from pane content for supported agents", () => {
    const snapshot = createStateSnapshot(
      [{ agent: "pi", session: "%2", state: "working", ts: 100 }],
      [],
    );

    const content = "~/code · 11 pkgs • ↻...  (sub) · 9.5%/400k · 1h18m\n(github-copilot) GPT-5.4";

    expect(mergedContextTokens("pi", "%2", content, snapshot)).toEqual({});
  });

  it("returns stored metadata for supported agents without consulting pane content", () => {
    const snapshot = createStateSnapshot(
      [{
        agent: "codex",
        session: "%3",
        state: "working",
        ts: 100,
        provider: "openai",
        modelId: "gpt-5-codex",
        modelLabel: "GPT-5 Codex",
      }],
      [],
    );

    expect(resolveModelInfo("codex", "%3", "stale footer", snapshot)).toEqual({
      provider: "openai",
      modelId: "gpt-5-codex",
      modelLabel: "GPT-5 Codex",
      model: "openai/gpt-5-codex",
    });
  });
});
