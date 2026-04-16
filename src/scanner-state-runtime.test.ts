import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

  it("returns no codex context usage when neither hook state nor session log has it", () => {
    const snapshot = createStateSnapshot(
      [{ agent: "codex", session: "%4", state: "working", ts: 100, externalSessionId: `vitest-missing-${Date.now()}` }],
      [],
    );

    const content = "gpt-5.4 high fast · backlog-app · main · Context [█▉   ] · weekly 90% · 258K window · Fast on";

    expect(mergedContextTokens("codex", "%4", content, snapshot)).toEqual({});
  });

  it("reads codex context usage from a fresh session log sample", () => {
    const externalSessionId = `vitest-codex-fresh-${Date.now()}`;
    const sessionDir = join(homedir(), ".codex", "sessions", "2099", "01", "01");
    const sessionPath = join(sessionDir, `rollout-2099-01-01T00-01-40-${externalSessionId}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionPath, `${JSON.stringify({
      timestamp: "1970-01-01T00:01:40.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 54321 },
          model_context_window: 258400,
        },
      },
    })}\n`);

    try {
      const snapshot = createStateSnapshot(
        [{ agent: "codex", session: "%fresh", state: "working", ts: 100, externalSessionId }],
        [],
      );

      expect(mergedContextTokens("codex", "%fresh", "", snapshot)).toEqual({
        contextTokens: 54321,
        contextMax: 258400,
      });
    } finally {
      rmSync(sessionPath, { force: true });
    }
  });

  it("ignores codex session usage when it is stale relative to pane state", () => {
    const externalSessionId = `vitest-codex-stale-${Date.now()}`;
    const sessionDir = join(homedir(), ".codex", "sessions", "2099", "01", "01");
    const sessionPath = join(sessionDir, `rollout-2099-01-01T00-01-40-${externalSessionId}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionPath, `${JSON.stringify({
      timestamp: "1970-01-01T00:01:40.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 54321 },
          model_context_window: 258400,
        },
      },
    })}\n`);

    try {
      const snapshot = createStateSnapshot(
        [{ agent: "codex", session: "%stale", state: "idle", ts: 1000, externalSessionId }],
        [],
      );

      expect(mergedContextTokens("codex", "%stale", "", snapshot)).toEqual({});
    } finally {
      rmSync(sessionPath, { force: true });
    }
  });

  it("prefers stored codex context usage over session-log reads", () => {
    const snapshot = createStateSnapshot(
      [{ agent: "codex", session: "%5", state: "working", ts: 100, contextTokens: 1234, contextMax: 5678 }],
      [],
    );

    const content = "gpt-5.4 high fast · backlog-app · main · Context [█▉   ] · weekly 90% · 258K window · Fast on";

    expect(mergedContextTokens("codex", "%5", content, snapshot)).toEqual({
      contextTokens: 1234,
      contextMax: 5678,
    });
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
