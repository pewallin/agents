import { describe, expect, it } from "vitest";
import { filterConversations, openInLabel, pickConversation, relativeTime, type PaneConversation } from "./conversations";

const now = Date.parse("2026-11-09T12:00:00Z");
const at = (secondsAgo: number) => Math.round(now / 1000) - secondsAgo;

const conversations: PaneConversation[] = [
  { sessionId: "a1", title: "Fix the login bug", updatedAt: at(7200) },
  { sessionId: "b2", title: "Release notes for build 12", updatedAt: at(60) , current: true },
  { sessionId: "c3", title: "Login page design", updatedAt: at(86400 * 3), openIn: { pane: "%12", window: "web" } },
];

describe("filterConversations", () => {
  it("lists newest first, all of them for no query", () => {
    expect(filterConversations(conversations, "").map((entry) => entry.sessionId)).toEqual(["b2", "a1", "c3"]);
  });

  it("keeps those with every word of the query in their title or id, any case", () => {
    expect(filterConversations(conversations, "LOGIN").map((entry) => entry.sessionId)).toEqual(["a1", "c3"]);
    expect(filterConversations(conversations, "login bug").map((entry) => entry.sessionId)).toEqual(["a1"]);
    expect(filterConversations(conversations, "c3").map((entry) => entry.sessionId)).toEqual(["c3"]);
    expect(filterConversations(conversations, "nothing")).toEqual([]);
  });
});

describe("relativeTime", () => {
  it("says how long ago, in the largest unit that fits", () => {
    expect(relativeTime(at(20), now)).toBe("just now");
    expect(relativeTime(at(5 * 60), now)).toBe("5 min ago");
    expect(relativeTime(at(2 * 3600 + 100), now)).toBe("2 h ago");
    expect(relativeTime(at(30 * 3600), now)).toBe("yesterday");
    expect(relativeTime(at(3 * 86400), now)).toBe("3 d ago");
    expect(relativeTime(at(40 * 86400), now)).toMatch(/\d/);
    expect(relativeTime(0, now)).toBe("");
  });
});

describe("pickConversation", () => {
  it("does nothing for the open one, shows the pane that has one, opens the others here", () => {
    expect(pickConversation(conversations[1])).toEqual({ kind: "current" });
    expect(pickConversation(conversations[2])).toEqual({ kind: "show", pane: "%12" });
    expect(pickConversation(conversations[0])).toEqual({ kind: "open", conversation: conversations[0] });
    expect(pickConversation({ sessionId: "d", title: "x", updatedAt: 1, openIn: { pid: 42 } })).toEqual({ kind: "elsewhere", label: "open in another app" });
  });

  it("names where another pane has it: its window and the pane", () => {
    expect(openInLabel({ pane: "%12", window: "web" })).toBe("open in web (%12)");
    expect(openInLabel({ pane: "%12" })).toBe("open in %12");
  });
});
