import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changesSince, commitChanges, commitInfo, inside, looksLikePath, peekFile, readBeads, resolveNames, snapshotTree, splitLine, treeDiff } from "./acp-peek.js";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acp-peek-")));
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "web/src"), { recursive: true });
  writeFileSync(join(root, "web/src/view.css"), Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"));
  writeFileSync(join(root, "README.md"), "# Hello\n");
  writeFileSync(join(root, "shot.png"), "png");
  mkdirSync(join(root, ".beads"));
  writeFileSync(join(root, ".beads/issues.jsonl"), `${JSON.stringify({ id: "bd-abhn", title: "Native ACP view", status: "in_progress", priority: 1 })}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "First");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("names", () => {
  it("splits a line off a name", () => {
    expect(splitLine("view.css:12")).toEqual({ name: "view.css", line: 12 });
    expect(splitLine("view.css:12:3")).toEqual({ name: "view.css", line: 12 });
    expect(splitLine("a/view.css#L40")).toEqual({ name: "a/view.css", line: 40 });
    expect(splitLine("view.css")).toEqual({ name: "view.css" });
  });

  it("knows what could be a path", () => {
    expect(looksLikePath("web/src/view.css")).toBe(true);
    expect(looksLikePath("view.css")).toBe(true);
    expect(looksLikePath("npm run build")).toBe(false);
    expect(looksLikePath("https://example.com/a.js")).toBe(false);
    expect(looksLikePath("main")).toBe(false);
  });

  it("resolves files, unique file names, images, beads and commits, and nothing outside the directory", async () => {
    const sha = git("rev-parse", "HEAD").trim();
    const resolved = await resolveNames(
      ["web/src/view.css:3", "view.css", "shot.png", "bd-abhn", sha.slice(0, 7), "../etc/passwd", "/etc/hosts", "missing.ts"],
      { cwd: root, files: async () => git("ls-files").split("\n").filter(Boolean) },
    );
    expect(resolved["web/src/view.css:3"]).toEqual({ kind: "file", path: join(root, "web/src/view.css"), rel: "web/src/view.css", line: 3 });
    expect(resolved["view.css"]).toMatchObject({ kind: "file", rel: "web/src/view.css" });
    expect(resolved["shot.png"]).toMatchObject({ kind: "image" });
    expect(resolved["bd-abhn"]).toEqual({ kind: "bead", id: "bd-abhn", title: "Native ACP view", status: "in_progress" });
    expect(resolved[sha.slice(0, 7)]).toMatchObject({ kind: "commit", sha, subject: "First" });
    expect(resolved["../etc/passwd"]).toBeNull();
    expect(resolved["/etc/hosts"]).toBeNull();
    expect(resolved["missing.ts"]).toBeNull();
  });

  it("reads files only inside the directory", () => {
    expect(inside(root, "README.md")).toBe(join(root, "README.md"));
    expect(inside(root, "/etc/hosts")).toBeNull();
    expect(peekFile(root, "/etc/hosts")).toBeNull();
  });

  it("peeks at the lines around a line", () => {
    const peek = peekFile(root, "web/src/view.css", 20, 2);
    expect(peek).toMatchObject({ rel: "web/src/view.css", start: 18, line: 20, total: 30 });
    expect(peek?.lines).toEqual(["line 18", "line 19", "line 20", "line 21", "line 22"]);
  });

  it("reads the project's beads", () => {
    expect(readBeads(join(root, "web/src")).get("bd-abhn")?.priority).toBe(1);
  });
});

describe("a turn's changes", () => {
  it("counts what changed since the snapshot, also shell edits and new files, and leaves the index alone", async () => {
    git("add", "README.md");
    const indexBefore = readFileSync(join(root, ".git/index"));
    const tree = await snapshotTree(root);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(root, "web/src/view.css"), Array.from({ length: 30 }, (_, index) => (index === 4 ? "changed" : `line ${index + 1}`)).join("\n"));
    writeFileSync(join(root, "new.txt"), "a\nb\n");
    const changes = await changesSince(root, tree!);
    expect(changes?.files).toEqual([
      { path: join(root, "new.txt"), rel: "new.txt", added: 2, removed: 0, binary: false },
      { path: join(root, "web/src/view.css"), rel: "web/src/view.css", added: 1, removed: 1, binary: false },
    ]);
    const diff = await treeDiff(root, tree!, changes!.tree, "web/src/view.css");
    expect(diff).toContain("-line 5\n+changed");
    expect(readFileSync(join(root, ".git/index")).equals(indexBefore)).toBe(true);
    expect(git("status", "--porcelain")).toContain("?? new.txt");
  });

  it("has no snapshot outside a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "acp-plain-"));
    try {
      expect(await snapshotTree(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("commits", () => {
  it("tells what a commit changed, before and after", async () => {
    writeFileSync(join(root, "README.md"), "# Hello\nworld\n");
    git("commit", "-q", "-am", "Second");
    const info = await commitInfo(root, git("rev-parse", "--short", "HEAD").trim());
    expect(info).toMatchObject({ subject: "Second", author: "T", files: [{ rel: "README.md", added: 1, removed: 0 }] });
    const changes = await commitChanges(root, info!.sha);
    expect(changes).toEqual([{ path: join(root, "README.md"), added: 1, removed: 0, edits: [{ oldText: "# Hello\n", newText: "# Hello\nworld\n" }] }]);
  });
});
