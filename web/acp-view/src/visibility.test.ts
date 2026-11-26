import { describe, expect, it } from "vitest";
import { emptySession, reduce } from "./session-state";
import { waitsWhileHidden, whenShown } from "./visibility";

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

describe("whenShown", () => {
  const live = emptySession();
  const loading = reduce(live, { type: "loading" });
  const chunk = { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } as const;

  it("shows what an agent streams once a frame while the page is seen, history too", () => {
    expect(whenShown(live, chunk, false)).toBe("frame");
    expect(whenShown(loading, chunk, false)).toBe("frame");
  });

  it("holds a live turn for a hidden page and lets a loading history through", () => {
    expect(whenShown(live, chunk, true)).toBe("shown");
    expect(whenShown(loading, chunk, true)).toBe("now");
  });

  it("lets everything else through at once", () => {
    for (const hidden of [false, true]) {
      expect(whenShown(live, { type: "promptEnded" }, hidden)).toBe("now");
      expect(whenShown(live, { type: "promptSent", blocks: [] }, hidden)).toBe("now");
      expect(whenShown(live, { type: "loaded" }, hidden)).toBe("now");
    }
  });
});
