// What the ACP view's chips and peeks read through the pane's host: what a name the agent wrote
// stands for (a file, a bead, a commit), a few lines of a file, the changes of a turn from a git
// snapshot, a commit, a bead and a web page's title. The host reads files only inside the pane's
// directory, and it never touches the user's index, stashes or branches: a turn's snapshot is
// written with a temporary index.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".heic", ".tif", ".tiff"]);

export type Resolved =
  | { kind: "file" | "image" | "dir"; path: string; rel: string; line?: number }
  | { kind: "bead"; id: string; title: string; status: string }
  | { kind: "commit"; sha: string; short: string; subject: string };

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, timeout: 15_000, maxBuffer }, (error, stdout) => {
      if (error) reject(error);
      else resolveRun(stdout);
    });
  });
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, maxBuffer?: number): Promise<string> {
  return run("git", ["-c", "core.quotepath=off", ...args], cwd, env, maxBuffer);
}

/** The real path of `path` when it is inside `root` (the pane's directory), else null. */
export function inside(root: string, path: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(isAbsolute(path) ? path : join(root, path));
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
  } catch {
    return null;
  }
}

/** A name as the agent writes it, without its line: `Foo.swift:12`, `Foo.swift:12:3`, `Foo.swift#L12`. */
export function splitLine(name: string): { name: string; line?: number } {
  const hash = name.match(/^(.*)#L(\d+)(?:-L?\d+)?$/);
  if (hash) return { name: hash[1], line: Number(hash[2]) };
  const colon = name.match(/^(.*?):(\d+)(?::\d+)?(?:-\d+)?$/);
  if (colon && colon[1]) return { name: colon[1], line: Number(colon[2]) };
  return { name };
}

export const BEAD_PATTERN = /^[a-z][a-z0-9]{0,11}-[a-z0-9]{2,8}(?:\.\d+)*$/;
export const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/** Whether a name could be a file at all: a path, or a name with an extension. */
export function looksLikePath(name: string): boolean {
  if (!name || name.length > 400 || /\s/.test(name) || /^[a-z]+:\/\//i.test(name)) return false;
  return name.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(name);
}

interface ResolveContext {
  cwd: string;
  files: () => Promise<string[]>;
}

/** What each name stands for, or null. Files must be inside the pane's directory; a bare file
 *  name stands for the one project file of that name, if there is exactly one. */
export async function resolveNames(names: string[], context: ResolveContext): Promise<Record<string, Resolved | null>> {
  const result: Record<string, Resolved | null> = {};
  let projectFiles: string[] | undefined;
  let beads: Map<string, Bead> | undefined;
  for (const raw of names.slice(0, 200)) {
    if (typeof raw !== "string" || raw in result) continue;
    result[raw] = null;
    const { name, line } = splitLine(raw.trim());
    if (BEAD_PATTERN.test(name) && !looksLikePath(name)) {
      beads ??= readBeads(context.cwd);
      const bead = beads.get(name);
      if (bead) { result[raw] = { kind: "bead", id: bead.id, title: bead.title, status: bead.status }; continue; }
    }
    // A hash git knows (all digits too: git decides).
    if (COMMIT_PATTERN.test(name)) {
      const commit = await commitSummary(context.cwd, name).catch(() => null);
      if (commit) { result[raw] = { kind: "commit", sha: commit.sha, short: commit.short, subject: commit.subject }; continue; }
    }
    if (!looksLikePath(name)) continue;
    const expanded = name.replace(/^file:\/\//, "").replace(/^\.\//, "");
    let path = inside(context.cwd, expanded);
    if (!path && !expanded.includes("/") && !isAbsolute(expanded)) {
      projectFiles ??= await context.files();
      const matches = projectFiles.filter((file) => file === expanded || file.endsWith(`/${expanded}`));
      if (matches.length === 1) path = inside(context.cwd, matches[0]);
    }
    if (!path) continue;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    const kind = stat.isDirectory() ? "dir" : IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) ? "image" : "file";
    result[raw] = { kind, path, rel: relative(realpathSync(context.cwd), path) || basename(path), ...(line ? { line } : {}) };
  }
  return result;
}

/** Lines of a text file around a line (or its start). */
export function peekFile(cwd: string, name: string, line?: number, around = 6): { path: string; rel: string; start: number; lines: string[]; total: number; line?: number } | null {
  const path = inside(cwd, name);
  if (!path) return null;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) return null;
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8000).includes(0)) return null;
  const all = buffer.toString("utf8").split("\n");
  const center = line && line > 0 ? Math.min(line, all.length) : 1;
  const start = line ? Math.max(1, center - around) : 1;
  const end = Math.min(all.length, line ? center + around : around * 2);
  return { path, rel: relative(realpathSync(cwd), path), start, lines: all.slice(start - 1, end).map((text) => text.slice(0, 400)), total: all.length, ...(line ? { line: center } : {}) };
}

// --- a turn's changes, from git ------------------------------------------------------------

async function toplevel(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || null;
}

/** The working tree as a tree object, written with a temporary index that starts as a copy of
 *  the real one (so unchanged files are not hashed again). Null outside a git repository. */
export async function snapshotTree(cwd: string): Promise<string | null> {
  const top = await toplevel(cwd);
  if (!top) return null;
  const directory = mkdtempSync(join(tmpdir(), "agents-turn-"));
  const index = join(directory, "index");
  try {
    const realIndex = resolve(top, (await git(top, ["rev-parse", "--git-path", "index"])).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    await git(top, ["add", "-A"], env);
    return (await git(top, ["write-tree"], env)).trim() || null;
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface TreeChange { path: string; rel: string; added: number; removed: number; binary: boolean }

/** What changed in the working tree since a snapshot: per file, lines added and removed. */
export async function changesSince(cwd: string, tree: string): Promise<{ tree: string; files: TreeChange[] } | null> {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
  const top = await toplevel(cwd);
  const now = await snapshotTree(cwd);
  if (!top || !now) return null;
  const output = await git(top, ["diff", "--numstat", "--no-renames", "-z", tree, now]);
  const files: TreeChange[] = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    const [added, removed, ...rest] = entry.split("\t");
    const rel = rest.join("\t");
    files.push({ path: join(top, rel), rel, added: Number(added) || 0, removed: Number(removed) || 0, binary: added === "-" });
  }
  return { tree: now, files };
}

/** One file's diff between two trees, unified. */
export async function treeDiff(cwd: string, from: string, to: string, path: string): Promise<string> {
  const top = await toplevel(cwd);
  if (!top || !/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) return "";
  const rel = relative(top, isAbsolute(path) ? path : join(cwd, path));
  if (rel.startsWith("..")) return "";
  return git(top, ["diff", "--no-renames", "-U3", from, to, "--", rel]).catch(() => "");
}

async function blob(top: string, treeish: string, rel: string): Promise<string | null> {
  return git(top, ["show", `${treeish}:${rel}`], undefined, 4 * 1024 * 1024).catch(() => null);
}

/** A file's text before and after, for a review of changes git saw (a shell edit). */
export async function versionsBetween(cwd: string, from: string, to: string, path: string): Promise<{ oldText: string | null; newText: string } | null> {
  const top = await toplevel(cwd);
  if (!top) return null;
  const rel = relative(top, isAbsolute(path) ? path : join(cwd, path));
  if (rel.startsWith("..")) return null;
  const [oldText, newText] = await Promise.all([blob(top, from, rel), blob(top, to, rel)]);
  return { oldText, newText: newText ?? "" };
}

// --- commits -------------------------------------------------------------------------------

export interface CommitSummary { sha: string; short: string; author: string; when: string; subject: string; body: string }

export async function commitSummary(cwd: string, sha: string): Promise<CommitSummary | null> {
  if (!COMMIT_PATTERN.test(sha)) return null;
  const output = await git(cwd, ["show", "-s", "--format=%H%x00%h%x00%an%x00%ar%x00%s%x00%b", `${sha}^{commit}`]);
  const [full, short, author, when, subject, body] = output.split("\0");
  return full ? { sha: full.trim(), short, author, when, subject, body: (body ?? "").trim() } : null;
}

/** A commit and the files it changed. */
export async function commitInfo(cwd: string, sha: string): Promise<(CommitSummary & { files: Array<{ rel: string; added: number; removed: number }> }) | null> {
  const summary = await commitSummary(cwd, sha).catch(() => null);
  if (!summary) return null;
  const numstat = await git(cwd, ["show", "--numstat", "--no-renames", "--format=", "-z", summary.sha]);
  const files = numstat.split("\0").filter(Boolean).map((entry) => {
    const [added, removed, ...rest] = entry.replace(/^\n/, "").split("\t");
    return { rel: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
  });
  return { ...summary, files };
}

/** A commit's changes as a review shows them: each file before and after. */
export async function commitChanges(cwd: string, sha: string): Promise<Array<{ path: string; added: number; removed: number; edits: Array<{ oldText: string | null; newText: string }> }>> {
  const info = await commitInfo(cwd, sha);
  const top = await toplevel(cwd);
  if (!info || !top) return [];
  const parent = await git(top, ["rev-parse", "--verify", "-q", `${info.sha}^`]).then((value) => value.trim(), () => "");
  return Promise.all(info.files.slice(0, 40).map(async (file) => ({
    path: join(top, file.rel),
    added: file.added,
    removed: file.removed,
    edits: [{ oldText: parent ? await blob(top, parent, file.rel) : null, newText: (await blob(top, info.sha, file.rel)) ?? "" }],
  })));
}

// --- beads ---------------------------------------------------------------------------------

export interface Bead { id: string; title: string; status: string; priority?: number; type?: string; description?: string; notes?: string; updated?: string }

/** The beads of the project the directory is in (.beads/issues.jsonl, here or in a folder above). */
export function readBeads(cwd: string): Map<string, Bead> {
  const beads = new Map<string, Bead>();
  let directory = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    const file = join(directory, ".beads", "issues.jsonl");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (typeof value.id !== "string") continue;
          beads.set(value.id, {
            id: value.id,
            title: String(value.title ?? ""),
            status: String(value.status ?? ""),
            priority: typeof value.priority === "number" ? value.priority : undefined,
            type: typeof value.issue_type === "string" ? value.issue_type : undefined,
            description: typeof value.description === "string" ? value.description : undefined,
            notes: typeof value.notes === "string" ? value.notes : undefined,
            updated: typeof value.updated_at === "string" ? value.updated_at : undefined,
          });
        } catch { /* a line being written */ }
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return beads;
}

// --- panes --------------------------------------------------------------------------------

/** What the agents' hooks last said of each pane (working, idle, approval, …), from the state
 *  directory: <agent>-<pane>.json, the newest when a pane had several agents. */
export function paneStates(stateDirectory: string, paneIds: string[]): Record<string, string> {
  const wanted = new Set(paneIds);
  const newest = new Map<string, { at: number; state: string }>();
  let entries: string[] = [];
  try { entries = readdirSync(stateDirectory); } catch { return {}; }
  for (const entry of entries) {
    const match = entry.match(/-(%\d+)\.json$/);
    if (!match || !wanted.has(match[1])) continue;
    try {
      const file = join(stateDirectory, entry);
      const at = statSync(file).mtimeMs;
      const state = (JSON.parse(readFileSync(file, "utf8")) as { state?: unknown }).state;
      if (typeof state === "string" && at > (newest.get(match[1])?.at ?? -1)) newest.set(match[1], { at, state });
    } catch { /* being written */ }
  }
  return Object.fromEntries([...newest].map(([pane, value]) => [pane, value.state]));
}

// --- links ---------------------------------------------------------------------------------

const linkCache = new Map<string, Promise<{ title: string | null; site: string }>>();

/** A web page's title and site, read from the first part of the page. */
export function linkInfo(url: string): Promise<{ title: string | null; site: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Promise.resolve({ title: null, site: "" }); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve({ title: null, site: parsed.host });
  const site = parsed.host.replace(/^www\./, "");
  let cached = linkCache.get(parsed.href);
  if (!cached) {
    cached = (async () => {
      try {
        const response = await fetch(parsed.href, { signal: AbortSignal.timeout(3000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AgentsNext", Accept: "text/html" } });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html") || !response.body) return { title: null, site };
        const reader = response.body.getReader();
        let html = "";
        while (html.length < 96 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          html += new TextDecoder().decode(value);
          if (/<\/title>/i.test(html)) break;
        }
        void reader.cancel().catch(() => {});
        const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
        const title = og ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
        return { title: title ? decodeEntities(title.trim()).slice(0, 200) : null, site };
      } catch {
        return { title: null, site };
      }
    })();
    linkCache.set(parsed.href, cached);
    if (linkCache.size > 200) linkCache.delete(linkCache.keys().next().value!);
  }
  return cached;
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
