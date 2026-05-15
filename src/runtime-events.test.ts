import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { appendRuntimeStateEvent } from "./runtime-events.js";

describe("runtime state events", () => {
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

      appendRuntimeStateEvent("primary_state", "upsert", "codex", "%runtime-events-test");

      expect(existsSync(`${eventPath}.1`)).toBe(true);
      const activeLines = readFileSync(eventPath, "utf8").trim().split("\n");
      expect(activeLines).toHaveLength(1);
      expect(JSON.parse(activeLines[0])).toMatchObject({
        entity: "primary_state",
        op: "upsert",
        agent: "codex",
        surfaceId: "%runtime-events-test",
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
