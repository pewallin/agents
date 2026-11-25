import { describe, expect, it } from "vitest";
import { emptySession, reduce } from "./session-state";
import { waitsWhileHidden } from "./visibility";

describe("waitsWhileHidden", () => {
  const live = emptySession();
  const chunk = { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } as const;

  it("lets a live turn's chunks wait for the page to be shown", () => {
    expect(waitsWhileHidden(live, chunk)).toBe(true);
  });

  it("lets a session's history through as it loads", () => {
    const loading = reduce(live, { type: "loading" });
    expect(waitsWhileHidden(loading, chunk)).toBe(false);
  });

  it("lets everything else through at once", () => {
    expect(waitsWhileHidden(live, { type: "promptEnded" })).toBe(false);
    expect(waitsWhileHidden(live, { type: "agentState", state: "working" })).toBe(false);
    expect(waitsWhileHidden(live, { type: "permissionRequested", request: { id: "1", toolCall: { toolCallId: "t" }, options: [] } })).toBe(false);
  });
});
