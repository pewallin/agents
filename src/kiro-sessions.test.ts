import { describe, expect, it } from "vitest";
import { kiroContinuedSession, kiroResumeSessionId, parseKiroSessionList, type KiroListedSession } from "./kiro-sessions.js";

// The sessions Kiro listed in Peter's ~/code on 2026-11-09, after a restart whose Kiro refused
// `--resume-id a28d7390-…` as ambiguous: the v2 session, Kiro 3's copy of it, and a v3 session
// with the bare UUID an ACP load had made.
const listed: KiroListedSession[] = [
  { sessionId: "a28d7390-f2ce-4ff9-acaf-35bc3ac71525", source: "v3", updatedAt: "2026-11-09T08:01:37.667Z" },
  { sessionId: "cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL", source: "v3", updatedAt: "2026-11-09T08:01:24.628Z" },
  { sessionId: "cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM", source: "v3", updatedAt: "2026-11-02T20:14:32.749Z" },
  { sessionId: "a28d7390-f2ce-4ff9-acaf-35bc3ac71525", source: "v2", updatedAt: "2026-11-06T11:04:39.441Z" },
  { sessionId: "sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", source: "v3", updatedAt: "2026-11-09T09:00:00.000Z" },
];

describe("Kiro sessions", () => {
  it("goes on with a Kiro 2 session as the newest copy Kiro 3 made of it", () => {
    expect(kiroContinuedSession("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", listed)).toBe("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL");
  });

  it("keeps an id Kiro 3 made, and a UUID Kiro has made no copy of", () => {
    expect(kiroContinuedSession("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", listed)).toBe("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7");
    expect(kiroContinuedSession("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM", listed)).toBe("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM");
    expect(kiroContinuedSession("23625ecc-d93d-44e8-abe4-b706930b5565", listed)).toBe("23625ecc-d93d-44e8-abe4-b706930b5565");
  });

  it("asks Kiro only about a UUID", () => {
    const asked: string[] = [];
    const list = (cwd: string) => { asked.push(cwd); return listed; };
    expect(kiroResumeSessionId("sess_x", "/repo", list)).toBe("sess_x");
    expect(asked).toEqual([]);
    expect(kiroResumeSessionId("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", "/repo", list)).toBe("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL");
    expect(asked).toEqual(["/repo"]);
  });

  it("reads Kiro's JSON list, its last line, and nothing from output it cannot read", () => {
    const output = `Loading...\n[{"cwd":"/repo","sessions":[{"sessionId":"s1","source":"v3","title":"t","updatedAt":"2026-11-09T08:00:00Z"},{"sessionId":"v2","source":"v2","title":"t","updatedAt":"2026-11-08T08:00:00Z","messageCount":2},{"bad":true}],"complete":true}]\n`;
    expect(parseKiroSessionList(output).map((session) => session.sessionId)).toEqual(["s1", "v2"]);
    expect(parseKiroSessionList("error: not logged in")).toEqual([]);
    expect(parseKiroSessionList("")).toEqual([]);
  });
});
