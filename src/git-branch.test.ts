import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBranchCache, buildBranchCacheAsync } from "./scanner-discovery.js";

describe("branch lookup for pane directories", () => {
  let root: string | undefined;
  afterEach(() => {
    delete process.env.AGENTS_BRANCH_TEST_MARKER;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("never runs a directory name as a command", async () => {
    root = mkdtempSync(join(tmpdir(), "agents-branch-"));
    const marker = join(root, "pwned");
    process.env.AGENTS_BRANCH_TEST_MARKER = marker;
    const dir = join(root, "$(touch \"$AGENTS_BRANCH_TEST_MARKER\")");
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "trunk", dir]);
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "x"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const plain = join(root, "plain");
    mkdirSync(plain);

    expect(buildBranchCache(new Set([dir, plain]))).toEqual(new Map([[dir, "trunk"], [plain, undefined]]));
    expect(await buildBranchCacheAsync(new Set([dir, plain]))).toEqual(new Map([[dir, "trunk"], [plain, undefined]]));
    expect(existsSync(marker)).toBe(false);
  });
});
