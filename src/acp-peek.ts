// What the ACP view's chips and peeks read through the pane's host: what a name the agent wrote
// stands for (a file, a bead, a commit), a few lines of a file, the changes of a turn from a git
// snapshot, a commit, a bead and a web page's title. The host reads files only inside the pane's
// directory, and it never touches the user's index, stashes or branches: a turn's snapshot is
// written with a temporary index.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getProgramsDir } from "./paths.js";

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

/** Where coordinators keep their programs (briefs, reports, messages): the view reads those too. */
export function programsRoot(): string {
  return getProgramsDir();
}

/** The real path of an absolute path in the coordination's programs, or a path inside the pane's
 *  directory; else null. */
export function insideAllowed(cwd: string, path: string): string | null {
  return inside(cwd, path) ?? (isAbsolute(path) && existsSync(programsRoot()) ? inside(programsRoot(), path) : null);
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
  /** More directories a relative name is looked up in after the pane's: program folders. */
  bases?: () => Promise<string[]>;
}

/** The real path of an absolute path that exists, else null. */
function existing(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

let programCache: { at: number; pane: string | undefined; directories: Promise<string[]> } | undefined;

/** The program folders of the coordinators on the pane's tmux server, the pane's own first: a
 *  name a coordinator writes relative to its program (`OVERVIEW.md`, `tasks/ui/report.md`) is
 *  found there, as the terminal finds it (TerminalPaneLinkTargets in the app). Read from tmux each
 *  few seconds, so an agent made coordinator after its view opened has its program too. */
export function programDirectories(pane = process.env.TMUX_PANE): Promise<string[]> {
  if (!process.env.TMUX) return Promise.resolve([]);
  if (programCache && programCache.pane === pane && Date.now() - programCache.at < 5000) return programCache.directories;
  const directories = run("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{@agents_program}"], process.cwd()).then((out) => {
    const own: string[] = [];
    const others: string[] = [];
    for (const line of out.split("\n")) {
      const [id, program] = line.split("\t");
      if (!program) continue;
      const path = program.startsWith("~/") ? join(homedir(), program.slice(2)) : program;
      if (!isAbsolute(path)) continue;
      (id === pane ? own : others).push(path);
    }
    return [...new Set([...own, ...others])];
  }, () => []);
  programCache = { at: Date.now(), pane, directories };
  return directories;
}

/** What each name stands for, or null. A relative path is looked up in the pane's directory, then
 *  in the coordinators' program folders; a bare file name also stands for the one project file of
 *  that name, if there is exactly one. An absolute path or one under ~ stands for the file there,
 *  as in the terminal (reading it is another matter: see insideAllowed). */
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
    const written = name.replace(/^file:\/\//, "").replace(/^\.\//, "");
    const expanded = written.startsWith("~/") ? join(homedir(), written.slice(2)) : written;
    let path = isAbsolute(expanded) ? existing(expanded) : inside(context.cwd, expanded);
    if (!path && !isAbsolute(expanded)) {
      for (const base of await context.bases?.() ?? []) {
        path = inside(base, expanded);
        if (path) break;
      }
    }
    if (!path && !expanded.includes("/") && !isAbsolute(expanded)) {
      projectFiles ??= await context.files();
      const matches = projectFiles.filter((file) => file === expanded || file.endsWith(`/${expanded}`));
      if (matches.length === 1) path = inside(context.cwd, matches[0]);
    }
    if (!path) continue;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    const kind = stat.isDirectory() ? "dir" : IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) ? "image" : "file";
    const rel = relative(realpathSync(context.cwd), path);
    result[raw] = { kind, path, rel: rel && !rel.startsWith("..") ? rel : path.replace(homedir(), "~"), ...(line ? { line } : {}) };
  }
  return result;
}

/** Lines of a text file around a line (or its start). */
export function peekFile(cwd: string, name: string, line?: number, around = 6): { path: string; rel: string; start: number; lines: string[]; total: number; line?: number } | null {
  const path = insideAllowed(cwd, name);
  if (!path) return null;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) return null;
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8000).includes(0)) return null;
  const all = buffer.toString("utf8").split("\n");
  const center = line && line > 0 ? Math.min(line, all.length) : 1;
  const start = line ? Math.max(1, center - around) : 1;
  const end = Math.min(all.length, line ? center + around : around * 2);
  const rel = relative(realpathSync(cwd), path);
  return { path, rel: rel && !rel.startsWith("..") ? rel : path.replace(homedir(), "~"), start, lines: all.slice(start - 1, end).map((text) => text.slice(0, 400)), total: all.length, ...(line ? { line: center } : {}) };
}

/** A text file's whole text (a brief, a report), up to 256 KB. */
export function readText(cwd: string, name: string): string | null {
  const path = insideAllowed(cwd, name);
  const stat = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
  if (!path || !stat?.isFile() || stat.size > 256 * 1024) return null;
  const buffer = readFileSync(path);
  return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf8");
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

/** What a git command an agent asks to run does, in plain words, from git itself: "Commits 4 files
 *  on main. Nothing is pushed." Null for commands it has nothing to say about. */
export async function gitCommandSummary(cwd: string, command: string): Promise<string | null> {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "git") return null;
  const sub = words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (!branch) return null;
  const count = (text: string) => text.split("\n").filter(Boolean).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (sub === "commit") {
    const all = words.includes("-a") || words.includes("--all") || words.some((word) => /^-[a-zA-Z]*a[a-zA-Z]*$/.test(word));
    const staged = count(await git(cwd, ["diff", "--cached", "--name-only"]).catch(() => ""));
    const tracked = all ? count(await git(cwd, ["diff", "--name-only"]).catch(() => "")) : 0;
    const files = staged + tracked;
    return files ? `Commits ${plural(files, "file", "files")} on ${branch}. Nothing is pushed.` : `Nothing is staged on ${branch}; the commit may be empty or fail.`;
  }
  if (sub === "push") {
    const ahead = (await git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]).catch(() => "")).trim();
    const upstream = (await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")).trim();
    return upstream ? `Pushes ${plural(Number(ahead) || 0, "commit", "commits")} from ${branch} to ${upstream}.` : `Pushes ${branch}, which has no upstream yet.`;
  }
  if (sub === "add") return `Stages files on ${branch}. Nothing is committed.`;
  if (sub === "reset" || sub === "restore" || sub === "checkout" || sub === "clean" || sub === "stash") {
    const changed = count(await git(cwd, ["status", "--porcelain"]).catch(() => ""));
    return `${changed ? `${plural(changed, "file has", "files have")} changes on ${branch}` : `No changes on ${branch}`}; this command can discard or move them.`;
  }
  return null;
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

/** Where a file pasted or dropped into the view's field goes, so the agent can read it by its
 *  path: a folder of its own under the system's temporary directory, the name kept. */
export function saveAttachment(name: string, data: Buffer): string {
  const safe = basename(name).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "pasted";
  const root = join(tmpdir(), "agents-acp-attachments");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "a-"));
  const path = join(folder, safe);
  writeFileSync(path, data);
  return realpathSync(path);
}
