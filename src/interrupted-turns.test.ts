import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeLastTurnBoundary, claudeSessionTranscript, codexLastTurnBoundary } from "./interrupted-turns.js";

// Entries as Claude Code 2.1 wrote them on 2026-11-22 for a reply the user interrupted with Esc.
const user = (timestamp: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", timestamp, message: { role: "user", content }, ...extra });
const assistant = (timestamp: string, text: string) =>
  JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });

describe("claudeLastTurnBoundary", () => {
  it("reads a turn the user interrupted, while text or tools ran, and a turn started after it", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-turns-"));
    try {
      const transcript = join(root, "s.jsonl");
      writeFileSync(transcript, [
        user("2026-11-22T16:00:17.000Z", "Write an essay"),
        assistant("2026-11-22T16:00:25.097Z", "# The Quiet Persistence"),
        user("2026-11-22T16:00:25.126Z", [{ type: "text", text: "[Request interrupted by user]" }]),
        JSON.stringify({ type: "data-flow-records" }),
        "",
      ].join("\n"));
      expect(claudeLastTurnBoundary(transcript)).toEqual({ interrupted: true, at: Date.parse("2026-11-22T16:00:25.126Z") });

      appendFileSync(transcript, `${user("2026-11-22T16:01:00.000Z", "Go on")}\n`);
      expect(claudeLastTurnBoundary(transcript)).toEqual({ interrupted: false, at: Date.parse("2026-11-22T16:01:00.000Z") });

      appendFileSync(transcript, [
        user("2026-11-22T16:01:05.000Z", [{ type: "tool_result", tool_use_id: "t1", content: "The user doesn't want to proceed with this tool use." }]),
        user("2026-11-22T16:01:05.010Z", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
        user("2026-11-22T16:01:06.000Z", "subagent text", { isSidechain: true }),
        "",
      ].join("\n"));
      expect(claudeLastTurnBoundary(transcript)).toEqual({ interrupted: true, at: Date.parse("2026-11-22T16:01:05.010Z") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a session's transcript by its folder, or in any project folder", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-projects-"));
    try {
      const byCwd = join(root, "-Users-peter-code-my-app", "abcd-1.jsonl");
      mkdirSync(join(root, "-Users-peter-code-my-app"));
      writeFileSync(byCwd, "");
      expect(claudeSessionTranscript("abcd-1", "/Users/peter/code/my.app", root)).toBe(byCwd);
      const elsewhere = join(root, "-other", "abcd-2.jsonl");
      mkdirSync(join(root, "-other"));
      writeFileSync(elsewhere, "");
      expect(claudeSessionTranscript("abcd-2", "/Users/peter/code/my.app", root)).toBe(elsewhere);
      expect(claudeSessionTranscript("abcd-3", undefined, root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("codexLastTurnBoundary", () => {
  // Events as Codex 0.169 wrote them on 2026-11-22 for a reply the user interrupted with Esc.
  const event = (timestamp: string, type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...extra } });

  it("reads a turn the user interrupted, and a turn that started or finished after it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-turns-"));
    try {
      const rollout = join(root, "rollout-2026-11-22T17-05-48-01a20401.jsonl");
      writeFileSync(rollout, [
        event("2026-11-22T16:06:00.600Z", "task_started", { turn_id: "t1" }),
        JSON.stringify({ timestamp: "2026-11-22T16:06:10.653Z", type: "response_item", payload: { type: "message" } }),
        event("2026-11-22T16:06:10.670Z", "turn_aborted", { reason: "interrupted" }),
        "",
      ].join("\n"));
      expect(codexLastTurnBoundary(rollout)).toEqual({ interrupted: true, at: Date.parse("2026-11-22T16:06:10.670Z") });

      appendFileSync(rollout, `${event("2026-11-22T16:07:00.000Z", "task_started", { turn_id: "t2" })}\n`);
      expect(codexLastTurnBoundary(rollout)).toEqual({ interrupted: false, at: Date.parse("2026-11-22T16:07:00.000Z") });

      appendFileSync(rollout, `${event("2026-11-22T16:07:30.000Z", "task_complete", { turn_id: "t2" })}\n`);
      expect(codexLastTurnBoundary(rollout)).toEqual({ interrupted: false, at: Date.parse("2026-11-22T16:07:30.000Z") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
