// Paths and panes named in an agent's prose, found as the terminal finds them
// (TerminalPaneLinkResolver in the app): runs of path characters without the punctuation that
// ends a sentence, that hold a letter and a slash or a file extension; a line after a colon
// (`main.tsx:42`); a pane id (`%12`). Whether a token names anything is the host's to say: the
// view asks it (/api/resolve) and only a name that exists becomes a chip.
import type { ToolCall } from "./session-state";

const PATH_CHARACTER = /[A-Za-z0-9._\-/~+]/;

/** Whether a run of path characters could be a file or folder at all. */
export function looksLikePath(token: string): boolean {
  if (!/[A-Za-z]/.test(token)) return false;
  if (token.includes("/")) return token !== "/" && !token.startsWith("//");
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  return /^[A-Za-z0-9]{1,8}$/.test(token.slice(dot + 1)) && /[A-Za-z]/.test(token.slice(dot + 1));
}

/** The folders the agent worked in, most recent first: where the files its tools read and wrote
 *  are, where its commands ran (a command's own cwd, or the folder of a `cd` it starts with). The
 *  host looks a relative name up in their repositories after the pane's own directory, so a path
 *  the agent writes relative to another repository or worktree is a link too. */
export function workFolders(calls: readonly ToolCall[], limit = 20): string[] {
  const folders: string[] = [];
  const add = (folder: string | undefined) => {
    const path = folder?.replace(/\/+$/, "");
    if (path && path.startsWith("/") && !folders.includes(path)) folders.push(path);
  };
  for (const call of [...calls].reverse()) {
    if (folders.length >= limit) break;
    const input = (call.rawInput ?? {}) as Record<string, unknown>;
    for (const key of ["cwd", "workdir"]) if (typeof input[key] === "string") add(input[key] as string);
    const command = Array.isArray(input.command) ? input.command.join(" ") : typeof input.command === "string" ? input.command : "";
    add(command.match(/(?:^|[\s;&|(])cd\s+(["']?)(\/[^"'\s;&|)]+)\1/)?.[2]);
    for (const path of [...call.locations.map((location) => location.path), ...call.content.flatMap((entry) => (entry.type === "diff" ? [entry.path] : []))]) {
      if (typeof path === "string" && path.startsWith("/")) add(path.slice(0, path.lastIndexOf("/")) || "/");
    }
  }
  return folders.slice(0, limit);
}

export interface TextToken { start: number; end: number; token: string }

/** The paths (with a line, if one follows) and pane ids in a run of prose. */
export function pathTokens(text: string): TextToken[] {
  const found: TextToken[] = [];
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && PATH_CHARACTER.test(text[index])) {
      if (start < 0) start = index;
      continue;
    }
    if (start < 0) continue;
    const lower = start;
    start = -1;
    let upper = index;
    while (upper > lower && ".,-".includes(text[upper - 1])) upper -= 1;
    // A path inside a URL is the URL's.
    if (lower >= 1 && text[lower - 1] === ":" && text[lower] === "/") continue;
    if (upper - lower < 3) continue;
    const token = text.slice(lower, upper);
    if (!looksLikePath(token)) continue;
    // A line after the path: main.tsx:42, main.tsx:42:7.
    const line = upper === index ? text.slice(upper).match(/^:\d+(?::\d+)?/) : null;
    const end = upper + (line ? line[0].length : 0);
    found.push({ start: lower, end, token: text.slice(lower, end) });
    index = end - 1;
  }
  for (const match of text.matchAll(/(^|[\s(,;])(%\d+)(?=$|[\s),.;:])/g)) {
    const at = (match.index ?? 0) + match[1].length;
    if (!found.some((token) => at >= token.start && at < token.end)) found.push({ start: at, end: at + match[2].length, token: match[2] });
  }
  return found.sort((a, b) => a.start - b.start);
}

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** Where a name in prose is the text's own: code (it has its own chips), links, pictures. */
const SKIPPED = new Set(["code", "pre", "a", "img", "svg", "math"]);

/** The file a link points at, when it points at one: a file: URL, or an address with no scheme
 *  (`docs/report.md`, `/abs/path`, `~/notes.md`). Web links, fragments and other schemes are not
 *  files. */
export function linkedPath(href: unknown): string | undefined {
  if (typeof href !== "string" || !href || href.startsWith("#") || href.startsWith("//")) return undefined;
  if (/^file:/i.test(href)) {
    try {
      const path = decodeURIComponent(new URL(href).pathname);
      return path && path !== "/" ? path : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** A rehype plugin, run before the link filter (which lets web links alone through): a link to a
 *  file becomes a `span[data-path-ref]` with the link's text, which the view shows as that
 *  file's chip. The filter put "[blocked]" in its place. */
export function rehypeFileLinks() {
  const visit = (node: HastNode) => {
    for (const [index, child] of (node.children ?? []).entries()) {
      if (child.type !== "element") continue;
      const path = child.tagName === "a" ? linkedPath(child.properties?.href) : undefined;
      if (path !== undefined) {
        node.children![index] = { type: "element", tagName: "span", properties: { dataPathRef: path, dataPathLink: "true" }, children: child.children ?? [] };
        continue;
      }
      if (child.tagName !== "code" && child.tagName !== "pre") visit(child);
    }
  };
  return (tree: HastNode) => visit(tree);
}

/** A rehype plugin: each path or pane id in the prose becomes a `span[data-path-ref]`, which
 *  the view shows as a chip once the host says what it names. */
export function rehypePathRefs() {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "element") {
        if (!SKIPPED.has(child.tagName ?? "") && child.properties?.dataPathRef === undefined) visit(child);
        children.push(child);
        continue;
      }
      if (child.type !== "text" || !child.value) { children.push(child); continue; }
      const tokens = pathTokens(child.value);
      if (tokens.length === 0) { children.push(child); continue; }
      let at = 0;
      for (const token of tokens) {
        if (token.start > at) children.push({ type: "text", value: child.value.slice(at, token.start) });
        children.push({ type: "element", tagName: "span", properties: { dataPathRef: token.token }, children: [{ type: "text", value: token.token }] });
        at = token.end;
      }
      if (at < child.value.length) children.push({ type: "text", value: child.value.slice(at) });
    }
    node.children = children;
  };
  return (tree: HastNode) => visit(tree);
}

/** Whether a task name links where it stands in the prose as a plain word: a name of more than one
 *  word (`wi01-dts`, `ios_tests`, `v2.notes`), never a common word such as "docs", which only links
 *  in backticks. */
export function linksAsWord(task: string): boolean {
  return task.length >= 3 && /[-_.\d]/.test(task) && /[A-Za-z]/.test(task);
}

/** The task names of the program a run of prose names, each as a whole word (Thread links, L6:
 *  the coordinator writes a worker's task name, the view shows it as that thread). */
export function taskTokens(text: string, tasks: ReadonlySet<string>): TextToken[] {
  if (tasks.size === 0) return [];
  const found: TextToken[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9][\w.-]*[A-Za-z0-9]/g)) {
    const at = match.index ?? 0;
    // Part of a path or a longer name is not the task's.
    if (at > 0 && /[\w/~%.-]/.test(text[at - 1])) continue;
    const end = at + match[0].length;
    if (end < text.length && /[\w/]/.test(text[end])) continue;
    if (tasks.has(match[0])) found.push({ start: at, end, token: match[0] });
  }
  return found;
}

/** A rehype plugin, run before the one that finds paths: each task name of the program in the
 *  prose becomes a `span[data-path-ref]`, which the view shows as that thread's chip. */
export function rehypeTaskRefs(tasks: readonly string[]) {
  const names = new Set(tasks.filter(linksAsWord));
  const visit = (node: HastNode) => {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "element") {
        if (!SKIPPED.has(child.tagName ?? "") && child.properties?.dataPathRef === undefined) visit(child);
        children.push(child);
        continue;
      }
      if (child.type !== "text" || !child.value) { children.push(child); continue; }
      const tokens = taskTokens(child.value, names);
      if (tokens.length === 0) { children.push(child); continue; }
      let at = 0;
      for (const token of tokens) {
        if (token.start > at) children.push({ type: "text", value: child.value.slice(at, token.start) });
        children.push({ type: "element", tagName: "span", properties: { dataPathRef: token.token }, children: [{ type: "text", value: token.token }] });
        at = token.end;
      }
      if (at < child.value.length) children.push({ type: "text", value: child.value.slice(at) });
    }
    node.children = children;
  };
  return () => (tree: HastNode) => visit(tree);
}
