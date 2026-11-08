import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectChanges } from "./review-server.js";

let repo = "";
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

describe("agents review's changes", () => {
  it("reads a file against a revision, an untracked file and a commit", () => {
    repo = mkdtempSync(join(tmpdir(), "review-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git("commit", "-q", "-am", "second");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "new.txt"), "new\n");

    const uncommitted = collectChanges({ cwd: repo, base: "HEAD" });
    expect(uncommitted.map((change) => change.path).sort()).toEqual(["a.txt", "new.txt"]);
    const edited = uncommitted.find((change) => change.path === "a.txt")!;
    expect(edited).toMatchObject({ added: 1, removed: 0, edits: [{ oldText: "one\ntwo\n", newText: "one\ntwo\nthree\n" }] });
    expect(uncommitted.find((change) => change.path === "new.txt")).toMatchObject({ added: 1, edits: [{ oldText: null, newText: "new\n" }] });

    const commit = git("rev-parse", "HEAD").trim();
    expect(collectChanges({ cwd: repo, commit })).toEqual([
      { path: "a.txt", added: 1, removed: 0, edits: [{ oldText: "one\n", newText: "one\ntwo\n" }] },
    ]);
  });
});
