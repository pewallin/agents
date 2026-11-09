import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kiroContinuedSession, kiroHistoryForCwd, kiroSessionTranscript, kiroSetting } from "./kiro-sessions.js";

describe("Kiro sessions", () => {
  // The store in Peter's ~/code on 2026-11-09, after a restart whose Kiro refused
  // `--resume-id a28d7390-…` as ambiguous: the Kiro 2 session, two copies Kiro 3 made of it, and a
  // Kiro 3 session with the bare UUID an ACP load had made.
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-store-"));
    const v3 = (id: string, lastModifiedAt?: string) => {
      mkdirSync(join(root, "b46ad781d995a6ec", id), { recursive: true });
      writeFileSync(join(root, "b46ad781d995a6ec", id, "session.json"), JSON.stringify({ id, ...(lastModifiedAt ? { lastModifiedAt } : {}) }));
    };
    mkdirSync(join(root, "cli"), { recursive: true });
    writeFileSync(join(root, "cli", "a28d7390-f2ce-4ff9-acaf-35bc3ac71525.json"), "{}");
    writeFileSync(join(root, "cli", "a28d7390-f2ce-4ff9-acaf-35bc3ac71525.jsonl"), "{}\n");
    v3("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", "2026-11-09T08:01:37.667Z");
    v3("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL", "2026-11-09T08:01:24.628Z");
    v3("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM", "2026-11-02T20:14:32.749Z");
    v3("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", "2026-11-09T09:00:00.000Z");
    writeFileSync(join(root, "b46ad781d995a6ec", "sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", "messages.jsonl"), "{}\n");
    return root;
  };

  it("goes on with a Kiro 2 session as the newest copy Kiro 3 made of it", () => {
    const root = store();
    try {
      expect(kiroContinuedSession("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", root)).toBe("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an id Kiro 3 made, and a UUID Kiro has made no copy of", () => {
    const root = store();
    try {
      expect(kiroContinuedSession("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", root)).toBe("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7");
      expect(kiroContinuedSession("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM", root)).toBe("cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_JSBgjtcM");
      expect(kiroContinuedSession("23625ecc-d93d-44e8-abe4-b706930b5565", root)).toBe("23625ecc-d93d-44e8-abe4-b706930b5565");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a session's transcript in either store", () => {
    const root = store();
    try {
      expect(kiroSessionTranscript("sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", root)).toBe(join(root, "b46ad781d995a6ec", "sess_01ad5966-c91e-4e36-ac59-c0c2337e66c7", "messages.jsonl"));
      expect(kiroSessionTranscript("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", root)).toBe(join(root, "cli", "a28d7390-f2ce-4ff9-acaf-35bc3ac71525.jsonl"));
      // Once the newest copy has a transcript, the session goes on there.
      writeFileSync(join(root, "b46ad781d995a6ec", "cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL", "messages.jsonl"), "{}\n");
      expect(kiroSessionTranscript("a28d7390-f2ce-4ff9-acaf-35bc3ac71525", root)).toBe(join(root, "b46ad781d995a6ec", "cli_a28d7390-f2ce-4ff9-acaf-35bc3ac71525_SoQKktGL", "messages.jsonl"));
      expect(kiroSessionTranscript("sess_none", root)).toBeUndefined();
      expect(kiroSessionTranscript("../x", root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads Kiro's settings, none when it cannot", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiro-settings-"));
    try {
      writeFileSync(join(dir, "cli.json"), JSON.stringify({ "chat.defaultAgent": "agents-reporting", "chat.agentEngine": "v3" }));
      expect(kiroSetting("chat.agentEngine", join(dir, "cli.json"))).toBe("v3");
      expect(kiroSetting("chat.defaultAgent", join(dir, "cli.json"))).toBe("agents-reporting");
      expect(kiroSetting("chat.other", join(dir, "cli.json"))).toBeUndefined();
      expect(kiroSetting("chat.agentEngine", join(dir, "missing.json"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists a folder's conversations as Kiro's TUI resumes them, not one only opened", () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-sessions-"));
    const v3 = (id: string, fields: Record<string, unknown>, messages?: string) => {
      const directory = join(root, "abc123", id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "session.json"), JSON.stringify({ id, workspacePaths: ["/repo"], ...fields }));
      if (messages !== undefined) writeFileSync(join(directory, "messages.jsonl"), messages);
    };
    try {
      mkdirSync(join(root, "cli"), { recursive: true });
      writeFileSync(join(root, "cli", "aaaaaaaa-1111-2222-3333-444444444444.json"), JSON.stringify({ session_id: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/repo", title: "old", updated_at: "2026-10-19T07:00:00Z" }));
      writeFileSync(join(root, "cli", "bbbbbbbb-1111-2222-3333-444444444444.json"), JSON.stringify({ session_id: "bbbbbbbb-1111-2222-3333-444444444444", cwd: "/repo", title: "never copied", updated_at: "2026-10-01T07:00:00Z" }));
      writeFileSync(join(root, "cli", "cccccccc-1111-2222-3333-444444444444.json"), JSON.stringify({ session_id: "cccccccc-1111-2222-3333-444444444444", cwd: "/elsewhere", title: "other folder", updated_at: "2026-10-01T07:00:00Z" }));
      writeFileSync(join(root, "cli", "dddddddd-1111-2222-3333-444444444444.json"), JSON.stringify({ session_id: "dddddddd-1111-2222-3333-444444444444", cwd: "/repo", title: "only opened", updated_at: "2026-10-02T07:00:00Z" }));
      const prompt = `{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"hi"}]}}\n`;
      for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) writeFileSync(join(root, "cli", `${id}-1111-2222-3333-444444444444.jsonl`), prompt);
      const user = `{"payload":{"type":"user","content":"hi"}}\n`;
      v3("cli_aaaaaaaa-1111-2222-3333-444444444444_new", { title: "old", lastModifiedAt: "2026-11-07T12:00:00Z", modelId: "claude-sonnet" }, user);
      v3("cli_aaaaaaaa-1111-2222-3333-444444444444_older", { title: "old", lastModifiedAt: "2026-11-02T12:00:00Z" }, user);
      v3("aaaaaaaa-1111-2222-3333-444444444444", { title: "New Session", lastModifiedAt: "2026-11-09T08:00:00Z" }, user);
      v3("sess_opened", { title: "New Session", lastModifiedAt: "2026-11-09T10:00:00Z" }, `{"payload":{"type":"agent_note","content":"<session_context>"}}\n`);
      v3("sess_new", { title: "New Session", lastModifiedAt: "2026-11-08T08:00:00Z" }, `{"payload":{"type":"user","content":"Fix the build\\nnow"}}\n`);
      v3("sess_empty", { title: "New Session", lastModifiedAt: "2026-11-09T09:00:00Z" });
      expect(kiroHistoryForCwd("/repo", root).map((entry) => [entry.sessionId, entry.title])).toEqual([
        ["sess_new", "Fix the build"],
        ["cli_aaaaaaaa-1111-2222-3333-444444444444_new", "old"],
        ["bbbbbbbb-1111-2222-3333-444444444444", "never copied"],
      ]);
      // The one a pane has open is listed, said or not.
      expect(kiroHistoryForCwd("/repo", root, "sess_opened").map((entry) => entry.sessionId)[0]).toBe("sess_opened");
      expect(kiroHistoryForCwd("/nowhere", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
