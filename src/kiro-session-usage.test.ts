import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { kiroContextWindow, kiroUsageFromCliSession, kiroUsageFromV2Messages, readKiroSessionUsage } from "./kiro-session-usage.js";

// Shaped like Kiro's own files; the field names follow what Kiro writes.
const cliSession = {
  session_id: "a1b2c3",
  cwd: "/work/repo",
  session_state: {
    rts_model_state: { model_info: { model_id: "claude-opus-5.5" } },
    conversation_metadata: {
      user_turn_metadatas: [
        { end_timestamp: "2026-10-20T10:00:00Z", metering_usage: [{ value: 1.25, unit: "credit" }, { value: 0.5, unit: "credit" }], final_context_usage_percentage: 9.5 },
        { end_timestamp: "2026-10-20T10:05:00Z", metering_usage: [], final_context_usage_percentage: 18.2 },
        { end_timestamp: "2026-10-20T10:09:00Z", metering_usage: [{ value: 2, unit: "credit" }] },
      ],
    },
  },
};

function v2Lines(): string[] {
  return [
    { id: "e1", timestamp: "2026-10-20T10:00:00Z", payload: { type: "user", content: "hi" } },
    { id: "e2", timestamp: "2026-10-20T10:00:05Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 12.5 } } },
    { id: "e3", timestamp: "2026-10-20T10:00:06Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 3.5 }], status: "success" } },
    { id: "e4", timestamp: "2026-10-20T10:04:00Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 22 } } },
    { id: "e5", timestamp: "2026-10-20T10:04:01Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", usage: null }, { unit: "credit", usage: 1.5 }] } },
  ].map((line) => JSON.stringify(line)).concat(["not json", ""]);
}

describe("Kiro session usage", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "kiro-usage-"));
    roots.push(dir);
    return dir;
  }

  it("sums a CLI session's credits and takes its latest context percentage of the model's window", () => {
    expect(kiroUsageFromCliSession(cliSession)).toEqual({ contextTokens: 182_000, contextMax: 1_000_000, spend: 3.75, spendUnit: "credits" });
  });

  it("reads a v2 session's usage summaries and latest contextUsage", () => {
    expect(kiroUsageFromV2Messages(v2Lines(), "claude-sonnet-4")).toEqual({ contextTokens: 44_000, contextMax: 200_000, spend: 5, spendUnit: "credits" });
  });

  it("leaves out what a session has not recorded yet", () => {
    expect(kiroUsageFromCliSession({ session_state: { conversation_metadata: { user_turn_metadatas: [] } } })).toEqual({});
    expect(kiroUsageFromV2Messages([])).toEqual({});
  });

  it("takes a context window the model info names over the model family", () => {
    const named = { session_state: { rts_model_state: { model_info: { model_id: "claude-sonnet-4", context_window_tokens: 400_000 } }, conversation_metadata: { user_turn_metadatas: [{ final_context_usage_percentage: 50 }] } } };
    expect(kiroUsageFromCliSession(named)).toEqual({ contextTokens: 200_000, contextMax: 400_000 });
    expect(kiroContextWindow("claude-opus-4.6")).toBe(1_000_000);
    expect(kiroContextWindow("claude-haiku-4.5")).toBe(200_000);
  });

  it("finds a session in either store by the id Kiro's hooks report", () => {
    const sessions = root();
    mkdirSync(join(sessions, "cli"));
    writeFileSync(join(sessions, "cli", "a1b2c3.json"), JSON.stringify(cliSession));
    const v2 = join(sessions, "9f8e7d", "sess_x9y8");
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, "messages.jsonl"), v2Lines().join("\n"));
    writeFileSync(join(v2, "session.json"), JSON.stringify({ modelId: "claude-opus-5.5" }));

    expect(readKiroSessionUsage("a1b2c3", sessions)).toMatchObject({ contextTokens: 182_000, spend: 3.75 });
    expect(readKiroSessionUsage("x9y8", sessions)).toEqual({ contextTokens: 220_000, contextMax: 1_000_000, spend: 5, spendUnit: "credits" });
    expect(readKiroSessionUsage("sess_x9y8", sessions)).toMatchObject({ spend: 5 });
    expect(readKiroSessionUsage("missing", sessions)).toEqual({});
    expect(readKiroSessionUsage("../etc", sessions)).toEqual({});
  });
});
