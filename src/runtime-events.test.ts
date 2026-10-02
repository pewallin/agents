import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { appendRuntimeFocusRequest, appendRuntimeStateEvent } from "./runtime-events.js";

describe("runtime state events", () => {
  it("records a focus request the app reads as one", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-runtime-events-"));
    const eventPath = join(directory, "state-events.jsonl");
    const previousAgentsHome = process.env.AGENTS_HOME;
    const previousEventPath = process.env.AGENTS_RUNTIME_STATE_EVENTS_PATH;
    process.env.AGENTS_HOME = directory;
    process.env.AGENTS_RUNTIME_STATE_EVENTS_PATH = eventPath;
    try {
      appendRuntimeFocusRequest("%7");
      const event = JSON.parse(readFileSync(eventPath, "utf8").trim());
      expect(event).toMatchObject({ v: 1, entity: "focus", op: "request", agent: "agents", surfaceId: "%7", mux: "tmux" });
      expect(Math.abs(event.ts - Date.now() / 1000)).toBeLessThan(5);
    } finally {
      restoreEnv("AGENTS_HOME", previousAgentsHome);
      restoreEnv("AGENTS_RUNTIME_STATE_EVENTS_PATH", previousEventPath);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates the append-only event log before it can grow unbounded", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-runtime-events-"));
    const eventPath = join(directory, "state-events.jsonl");
    const previousAgentsHome = process.env.AGENTS_HOME;
    const previousEventPath = process.env.AGENTS_RUNTIME_STATE_EVENTS_PATH;
    const previousMaxBytes = process.env.AGENTS_RUNTIME_STATE_EVENTS_MAX_BYTES;

    process.env.AGENTS_HOME = directory;
    process.env.AGENTS_RUNTIME_STATE_EVENTS_PATH = eventPath;
    process.env.AGENTS_RUNTIME_STATE_EVENTS_MAX_BYTES = String(256 * 1024);

    try {
      writeFileSync(eventPath, "x".repeat(256 * 1024));

      appendRuntimeStateEvent("primary_state", "upsert", "codex", "%runtime-events-test", {
        state: "working",
        intent: "Run focused tests",
      });

      expect(existsSync(`${eventPath}.1`)).toBe(true);
      const activeLines = readFileSync(eventPath, "utf8").trim().split("\n");
      expect(activeLines).toHaveLength(1);
      expect(JSON.parse(activeLines[0])).toMatchObject({
        entity: "primary_state",
        op: "upsert",
        agent: "codex",
        surfaceId: "%runtime-events-test",
        state: "working",
        intent: "Run focused tests",
      });
    } finally {
      restoreEnv("AGENTS_HOME", previousAgentsHome);
      restoreEnv("AGENTS_RUNTIME_STATE_EVENTS_PATH", previousEventPath);
      restoreEnv("AGENTS_RUNTIME_STATE_EVENTS_MAX_BYTES", previousMaxBytes);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
