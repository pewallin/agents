import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listDoneProjection,
  recordDoneEvent,
  updateDoneProjection,
  AgentDoneError,
} from "./done.js";

const temporaryStores: string[] = [];

afterEach(() => {
  const store = process.env.AGENTS_DONE_STORE_PATH;
  if (store) {
    delete process.env.AGENTS_DONE_STORE_PATH;
  }
  for (const directory of temporaryStores.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("done projection persistence", () => {
  it("records Done events and lists the contract projection", () => {
    useTemporaryStore();

    const projection = recordDoneEvent(donePayload());

    expect(projection.contractVersion).toBe(1);
    expect(projection.records).toHaveLength(1);
    expect(projection.records[0]).toMatchObject({
      sessionIdentity: "external-session-1",
      hostID: "local-smoke",
      agentKind: "codex",
      externalSessionID: "external-session-1",
      title: "Smoke done event",
      statusSnapshot: "idle",
      createdAt: "2026-06-22T00:00:00Z",
      acknowledged: false,
      cleared: false,
    });
    expect(listDoneProjection()).toEqual(projection);
  });

  it("pins by external session, acknowledges the Done event without unpinning, then unpins", () => {
    useTemporaryStore();
    const recorded = recordDoneEvent(donePayload());
    const doneEventID = recorded.records[0].doneEventID;

    const pinned = updateDoneProjection({
      externalSessionID: "external-session-1",
      pin: true,
    });
    expect(pinned.pinnedSessions).toHaveLength(1);
    expect(pinned.pinnedSessions[0]).toMatchObject({
      sessionIdentity: "external-session-1",
      latestDoneEventID: doneEventID,
      title: "Smoke done event",
    });

    const acknowledged = updateDoneProjection({
      doneEventID,
      acknowledge: true,
    });
    expect(acknowledged.records[0].acknowledged).toBe(true);
    expect(acknowledged.pinnedSessions.map((session) => session.sessionIdentity)).toEqual(["external-session-1"]);

    const unpinned = updateDoneProjection({
      externalSessionID: "external-session-1",
      pin: false,
    });
    expect(unpinned.pinnedSessions).toEqual([]);
    expect(unpinned.records[0].doneEventID).toBe(doneEventID);
    expect(unpinned.records[0].acknowledged).toBe(true);
  });

  it("uses deterministic fallback identity when no external session id is present", () => {
    useTemporaryStore();

    const projection = recordDoneEvent({
      contractVersion: 1,
      hostID: "local",
      tmux: { session: "agents", window: "@1", pane: "%2" },
      agentKind: "codex",
      title: "Fallback identity",
      statusSnapshot: "idle",
      createdAt: "2026-06-22T00:00:00Z",
    });

    expect(projection.records[0].sessionIdentity).toBe("local|agents|@1|%2|codex");
  });

  it("rejects invalid update targets", () => {
    useTemporaryStore();

    expect(() => updateDoneProjection({ pin: true })).toThrow(AgentDoneError);
    expect(() => updateDoneProjection({ doneEventID: "missing", acknowledge: true })).toThrow("No Done event found");
  });
});

function useTemporaryStore(): void {
  const directory = mkdtempSync(join(tmpdir(), "agents-done-test-"));
  temporaryStores.push(directory);
  process.env.AGENTS_DONE_STORE_PATH = join(directory, "recent-done.json");
}

function donePayload() {
  return {
    contractVersion: 1,
    hostID: "local-smoke",
    tmux: {
      session: "smoke-session",
      window: "smoke-window",
      pane: "smoke-pane",
    },
    agentKind: "codex",
    externalSessionID: "external-session-1",
    title: "Smoke done event",
    detail: "Created by test",
    statusSnapshot: "idle",
    createdAt: "2026-06-22T00:00:00Z",
  };
}
