// Everything the agent names becomes a chip: a file (with this turn's +/− when it changed), an
// image, a pane, a link, a bead, a commit. A chip peeks on hover (a small glass card after
// ~320 ms) and opens on click: beside the pane in Agents Next, with ⌥ in the editor or the
// default browser. Names are resolved by the pane's host, which reads only inside the pane's
// directory (src/acp-peek.ts); what is not found stays plain code.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { diffLines } from "diff";
import { useCoordination, workerNamed } from "./coordination";
import type { FileChange } from "./turns";

export type ChipTarget =
  | { kind: "file" | "image" | "dir"; path: string; rel: string; line?: number }
  | { kind: "pane"; id: string; state?: string }
  | { kind: "url"; url: string }
  | { kind: "bead"; id: string; title: string; status: string }
  | { kind: "commit"; sha: string; short: string; subject: string };

/** What a chip needs of the view: the host's address book and how to open things. */
export interface ChipHost {
  cwd: string;
  inApp: boolean;
  /** GET (or POST with a body) to the pane's host, with the pane's token. */
  hostJson: <T>(path: string, body?: unknown) => Promise<T>;
  /** A URL of the host's own that a plain <img> may load (the token rides in the query). */
  rawURL: (path: string) => string;
  /** `alternate`: ⌥ was held (the editor, the default browser); `command`: ⌘ was, which does
   *  what a ⌘-click on the same link does in a terminal. */
  open: (target: ChipTarget, options: { alternate: boolean; command?: boolean; change?: FileChange }) => void;
}

export const ChipHostContext = createContext<ChipHost | null>(null);
/** The changes of the turn a chip is in: a changed file's chip shows its +/− and its hunks. */
export const TurnChangesContext = createContext<FileChange[]>([]);

// --- resolving names, batched ------------------------------------------------------------------

type Resolution = ChipTarget | null;
const resolved = new Map<string, Resolution>();
const waiting = new Map<string, Array<(value: Resolution) => void>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let currentHost: ChipHost | null = null;

function flush() {
  flushTimer = undefined;
  const host = currentHost;
  const names = [...waiting.keys()];
  if (!host || names.length === 0) return;
  const callbacks = new Map(names.map((name) => [name, waiting.get(name)!]));
  for (const name of names) waiting.delete(name);
  host.hostJson<{ resolved: Record<string, Resolution> }>("/api/resolve", { names }).then(
    (value) => {
      for (const name of names) {
        const result = value.resolved?.[name] ?? null;
        resolved.set(name, result);
        for (const callback of callbacks.get(name) ?? []) callback(result);
      }
    },
    () => { for (const name of names) for (const callback of callbacks.get(name) ?? []) callback(null); },
  );
}

/** What a name the agent wrote stands for, as the host finds it; undefined while it asks. */
export function useResolved(name: string | null): Resolution | undefined {
  const host = useContext(ChipHostContext);
  const panes = usePanes(host, name !== null && /^%\d+$/.test(name));
  const [value, setValue] = useState<Resolution | undefined>(() => (name === null ? null : immediate(name)));
  useEffect(() => {
    if (name === null || !host) { setValue(null); return; }
    const now = immediate(name);
    if (now !== undefined) { setValue(now); return; }
    if (/^%\d+$/.test(name)) return;
    let live = true;
    currentHost = host;
    const list = waiting.get(name) ?? [];
    list.push((result) => { if (live) setValue(result); });
    waiting.set(name, list);
    flushTimer ??= setTimeout(flush, 30);
    return () => { live = false; };
  }, [name, host]);
  if (name !== null && /^%\d+$/.test(name)) {
    if (!panes) return undefined;
    const pane = panes.find((entry) => entry.id === name);
    return pane ? { kind: "pane", id: name, state: pane.state } : null;
  }
  return value;
}

/** What each of many names stands for (a code block's paths), in the same batches as the chips';
 *  a name not answered yet is missing from the map. */
export function useResolvedNames(names: string[]): Map<string, Resolution> {
  const host = useContext(ChipHostContext);
  const key = names.join("\n");
  const [values, setValues] = useState<Map<string, Resolution>>(() => new Map(names.flatMap((name) => {
    const now = resolved.get(name);
    return now === undefined ? [] : [[name, now] as const];
  })));
  useEffect(() => {
    if (!host || names.length === 0) return;
    let live = true;
    const found = new Map<string, Resolution>();
    let asked = false;
    for (const name of names) {
      const now = resolved.get(name);
      if (now !== undefined) { found.set(name, now); continue; }
      asked = true;
      currentHost = host;
      const list = waiting.get(name) ?? [];
      list.push((result) => { if (!live) return; found.set(name, result); setValues(new Map(found)); });
      waiting.set(name, list);
    }
    setValues(new Map(found));
    if (asked) flushTimer ??= setTimeout(flush, 30);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, host]);
  return values;
}

function immediate(name: string): Resolution | undefined {
  if (/^https?:\/\/\S+$/i.test(name)) return { kind: "url", url: name };
  return resolved.get(name);
}

interface PaneSummary { id: string; command: string; title: string; state?: string }
let paneList: { at: number; panes: Promise<PaneSummary[]> } | undefined;

/** The panes of the pane's tmux session, with their agents' state, asked again every few seconds. */
function usePanes(host: ChipHost | null, wanted: boolean): PaneSummary[] | undefined {
  const [panes, setPanes] = useState<PaneSummary[] | undefined>(undefined);
  useEffect(() => {
    if (!wanted || !host) return;
    let live = true;
    const load = () => {
      if (!paneList || Date.now() - paneList.at > 4000) {
        paneList = { at: Date.now(), panes: host.hostJson<{ panes: PaneSummary[] }>("/api/panes").then((value) => value.panes, () => []) };
      }
      void paneList.panes.then((value) => { if (live) setPanes(value); });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [wanted, host]);
  return panes;
}

/** The change of the turn a path names, if it changed. */
export function changeFor(changes: FileChange[], path: string): FileChange | undefined {
  return changes.find((change) => change.path === path);
}

// --- the chip ----------------------------------------------------------------------------------

const ICONS: Record<string, ReactNode> = {
  file: <path d="M3.5 1.5h4l3 3v8h-7z M7.5 1.5v3h3" />,
  dir: <path d="M1.5 3.5h4l1 1.5h6v6.5h-11z" />,
  image: <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M2 10l3-3 2.5 2.5L9.5 7.5 12 10" /></>,
  pane: <><rect x="1.5" y="2" width="11" height="10" rx="1.6" /><path d="M4 5.5l2 1.5-2 1.5M7.5 9h2.5" /></>,
  url: <><circle cx="7" cy="7" r="5.5" /><path d="M1.5 7h11M7 1.5c2 2 2 9 0 11M7 1.5c-2 2-2 9 0 11" /></>,
  bead: <><circle cx="7" cy="7" r="5" /><circle cx="7" cy="7" r="1.8" /></>,
  commit: <><circle cx="7" cy="7" r="2.4" /><path d="M1 7h3.6M9.4 7H13" /></>,
};

function Icon({ kind }: { kind: string }) {
  return <svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">{ICONS[kind] ?? ICONS.file}</svg>;
}

const BUSY_STATES = new Set(["working", "compacting"]);
const ASKING_STATES = new Set(["approval", "question", "attention"]);

/** A chip for what a name stands for, or the fallback while it is not known to stand for anything. */
export function NamedChip({ name, label, fallback }: { name: string; label?: ReactNode; fallback: ReactNode }) {
  // A worker's task name stands for its pane (in a coordinator's or a worker's view).
  const worker = useCoordination((state) => workerNamed(state, name));
  const target = useResolved(worker ? null : name);
  if (worker) return <Chip target={{ kind: "pane", id: worker.pane, state: worker.status }} label={label ?? name} />;
  if (!target) return <>{fallback}</>;
  return <Chip target={target} label={label} />;
}

/** A file the turn changed, as its chip: an image's with the image mark. */
export function fileTarget(path: string, rel: string): ChipTarget {
  return { kind: IMAGE_EXTENSIONS.test(path) ? "image" : "file", path, rel };
}

export function Chip({ target, label }: { target: ChipTarget; label?: ReactNode }) {
  const host = useContext(ChipHostContext);
  const changes = useContext(TurnChangesContext);
  const peek = useContext(PeekContext);
  const element = useRef<HTMLSpanElement>(null);
  const change = target.kind === "file" || target.kind === "image" ? changeFor(changes, target.path) : undefined;
  const text = label ?? (target.kind === "file" || target.kind === "image" || target.kind === "dir"
    ? shortName(target.rel)
    : target.kind === "pane" ? target.id
      : target.kind === "url" ? siteOf(target.url)
        : target.kind === "bead" ? target.id
          : target.kind === "commit" ? target.short : "");
  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    peek?.hide(true);
    host?.open(target, { alternate: event.altKey, command: event.metaKey, change });
  };
  const state = target.kind === "pane" ? target.state : undefined;
  return (
    <span ref={element} className={`chip ${target.kind}${change ? " changed" : ""}`} role="link" tabIndex={0}
      data-path={target.kind === "file" || target.kind === "image" || target.kind === "dir" ? `${target.path}${target.line ? `:${target.line}` : ""}` : target.kind === "url" ? target.url : target.kind === "pane" ? target.id : undefined}
      draggable={target.kind === "file" || target.kind === "image"}
      onDragStart={(event) => {
        if (target.kind !== "file" && target.kind !== "image") return;
        event.dataTransfer.setData("text/uri-list", `file://${encodeURI(target.path)}`);
        event.dataTransfer.setData("text/plain", target.path);
      }}
      onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter") open(event); }}
      onMouseEnter={() => element.current && peek?.show(target, element.current, change)}
      onMouseLeave={() => peek?.hide(false)}>
      {target.kind === "pane"
        ? <span className={`live${state && BUSY_STATES.has(state) ? " work" : state && ASKING_STATES.has(state) ? " need" : state === "idle" || !state ? " idle" : ""}`} />
        : <Icon kind={target.kind} />}
      <span className="nm">{text}</span>
      {(target.kind === "file" || target.kind === "image") && target.line !== undefined && <span className="ln">:{target.line}</span>}
      {change && <span className="st"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span></span>}
      {target.kind === "bead" && <span className="st">{target.status.replace(/_/g, " ")}</span>}
    </span>
  );
}

function shortName(rel: string): string {
  const parts = rel.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : rel;
}

function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 22)}…` : parsed.pathname;
    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

// --- peeks -------------------------------------------------------------------------------------

interface PeekControl {
  show: (target: ChipTarget, anchor: HTMLElement, change?: FileChange) => void;
  /** Hides the peek, at once or after a moment in which the pointer can move onto it. */
  hide: (now: boolean) => void;
}

export const PeekContext = createContext<PeekControl | null>(null);

const PEEK_DELAY = 320;

/** The one peek of the view: a glass card beside the chip the pointer rests on. */
export function PeekLayer({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ target: ChipTarget; anchor: DOMRect; change?: FileChange } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const control = useMemo<PeekControl>(() => ({
    show(target, anchor, change) {
      clearTimeout(hideTimer.current);
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => setShown({ target, anchor: anchor.getBoundingClientRect(), change }), PEEK_DELAY);
    },
    hide(now) {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
      if (now) setShown(null);
      else hideTimer.current = setTimeout(() => setShown(null), 140);
    },
  }), []);
  useEffect(() => {
    if (!shown) return;
    const close = () => setShown(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", close); };
  }, [shown]);
  return (
    <PeekContext.Provider value={control}>
      {children}
      {shown && (
        <PeekCard anchor={shown.anchor} onEnter={() => clearTimeout(hideTimer.current)} onLeave={() => control.hide(false)}>
          <PeekBody target={shown.target} change={shown.change} />
          <div className="peek-hint">{clickHint(shown.target, Boolean(shown.change))}</div>
        </PeekCard>
      )}
    </PeekContext.Provider>
  );
}

/** What a click and a ⌘-click on a link do, as the peek and the tooltips say it. A link opens
 *  with a plain click, as on a web page; ⌘ opens a file in the editor and a page in the browser. */
export function clickHint(target: ChipTarget, changed = false): string {
  switch (target.kind) {
    case "file": return changed ? "Click: this turn's changes · ⌘-click: open in the editor" : "Click: open beside · ⌘-click: open in the editor";
    case "dir": return "Click: open beside · ⌘-click: open in the editor";
    case "image": return "Click: Quick Look · ⌘-click: open in the editor";
    case "url": return "Click: open beside · ⌘-click: open in your browser";
    case "pane": return "Click: show the pane";
    case "bead": case "commit": return "Click: open beside";
  }
}

function PeekCard({ anchor, children, onEnter, onLeave }: { anchor: DOMRect; children: ReactNode; onEnter: () => void; onLeave: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const place = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
      const below = anchor.bottom + 6;
      const top = below + height <= window.innerHeight - 12 || anchor.top - height - 6 < 12 ? below : anchor.top - height - 6;
      setPosition({ left, top });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);
  return (
    <div ref={card} className="peek" role="tooltip" onMouseEnter={onEnter} onMouseLeave={onLeave}
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: 0 }}>
      {children}
    </div>
  );
}

function useHost<T>(path: string | null, refreshMs?: number): { value?: T; failed: boolean } {
  const host = useContext(ChipHostContext);
  const [state, setState] = useState<{ value?: T; failed: boolean }>({ failed: false });
  useEffect(() => {
    if (!path || !host) return;
    let live = true;
    const load = () => host.hostJson<T>(path).then((value) => { if (live) setState({ value, failed: false }); }, () => { if (live) setState((previous) => ({ ...previous, failed: true })); });
    void load();
    const timer = refreshMs ? setInterval(load, refreshMs) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [path, host, refreshMs]);
  return state;
}

function PeekBody({ target, change }: { target: ChipTarget; change?: FileChange }) {
  if (change) return <ChangePeek change={change} />;
  switch (target.kind) {
    case "file": return <FilePeek path={target.path} line={target.line} />;
    case "dir": return <div className="peek-head"><Icon kind="dir" /> {target.rel}</div>;
    case "image": return <ImagePeek path={target.path} />;
    case "pane": return <PanePeek id={target.id} />;
    case "url": return <LinkPeek url={target.url} />;
    case "bead": return <BeadPeek id={target.id} />;
    case "commit": return <CommitPeek sha={target.sha} />;
  }
}

function Loading({ failed }: { failed: boolean }) {
  return <div className="peek-dim">{failed ? "Not available" : "…"}</div>;
}

function FilePeek({ path, line }: { path: string; line?: number }) {
  const { value, failed } = useHost<{ rel: string; start: number; lines: string[]; total: number; line?: number }>(
    `/api/peek/file?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`,
  );
  if (!value) return <Loading failed={failed} />;
  return (
    <>
      <div className="peek-head"><span className="mono">{value.rel}</span><span className="peek-dim">{value.total} lines</span></div>
      <div className="peek-code">
        {value.lines.map((text, index) => {
          const number = value.start + index;
          return <div key={number} className={number === value.line ? "hl" : undefined}><span className="no">{number}</span>{text || " "}</div>;
        })}
      </div>
    </>
  );
}

/** The changed lines of this turn's edits, the first eight, + and − coloured. */
export function changedLines(change: FileChange, limit = 8): { lines: Array<{ sign: "+" | "-"; text: string }>; more: number } {
  const lines: Array<{ sign: "+" | "-"; text: string }> = [];
  let total = 0;
  for (const edit of change.edits) {
    // An edit that adds a line after a last line without its newline changes no line but adds one.
    const withEnd = (text: string) => (text && !text.endsWith("\n") ? `${text}\n` : text);
    for (const part of diffLines(withEnd(edit.oldText ?? ""), withEnd(edit.newText))) {
      if (!part.added && !part.removed) continue;
      for (const text of part.value.replace(/\n$/, "").split("\n")) {
        total += 1;
        if (lines.length < limit) lines.push({ sign: part.added ? "+" : "-", text });
      }
    }
  }
  return { lines, more: total - lines.length };
}

/** Changed lines of a unified diff. */
export function diffTextLines(diff: string, limit = 8): { lines: Array<{ sign: "+" | "-"; text: string }>; more: number } {
  const all = diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  return { lines: all.slice(0, limit).map((line) => ({ sign: line[0] as "+" | "-", text: line.slice(1) })), more: Math.max(0, all.length - limit) };
}

function ChangePeek({ change }: { change: FileChange }) {
  const fromGit = change.edits.length === 0 && change.snapshot;
  const { value, failed } = useHost<{ diff: string }>(fromGit
    ? `/api/git/diff?from=${change.snapshot!.from}&to=${change.snapshot!.to}&path=${encodeURIComponent(change.path)}`
    : null);
  const shown = fromGit ? (value ? diffTextLines(value.diff) : null) : changedLines(change);
  return (
    <>
      <div className="peek-head"><span className="mono">{change.path.split("/").pop()}</span>
        <span className="peek-dim"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span> this turn</span></div>
      {!shown ? <Loading failed={failed} /> : (
        <div className="peek-code diff">
          {shown.lines.map((line, index) => <div key={index} className={line.sign === "+" ? "a" : "d"}><span className="no">{line.sign}</span>{line.text || " "}</div>)}
          {shown.more > 0 && <div className="peek-dim more">… {shown.more} more {shown.more === 1 ? "change" : "changes"}</div>}
        </div>
      )}
    </>
  );
}

function ImagePeek({ path }: { path: string }) {
  const host = useContext(ChipHostContext);
  return <img className="peek-image" alt="" src={host ? thumbnailURL(host, path, 640) : undefined} />;
}

function PanePeek({ id }: { id: string }) {
  const { value, failed } = useHost<{ text: string }>(`/api/panes/${encodeURIComponent(id)}/text?lines=40`, 1000);
  if (!value) return <Loading failed={failed} />;
  const lines = value.text.split("\n").filter((line) => line.trim()).slice(-8);
  return (
    <>
      <div className="peek-head"><span className="mono">{id}</span><span className="peek-dim">live</span></div>
      <div className="peek-code term">{lines.map((line, index) => <div key={index}>{line}</div>)}</div>
    </>
  );
}

function LinkPeek({ url }: { url: string }) {
  const { value } = useHost<{ title: string | null; site: string }>(`/api/link?url=${encodeURIComponent(url)}`);
  return (
    <>
      <div className="peek-title">{value?.title ?? (value ? url : "…")}</div>
      <div className="peek-dim">{value?.site ?? siteOf(url)}</div>
    </>
  );
}

function BeadPeek({ id }: { id: string }) {
  const { value, failed } = useHost<{ id: string; title: string; status: string; priority?: number; type?: string; description?: string }>(`/api/bead/${encodeURIComponent(id)}`);
  if (!value) return <Loading failed={failed} />;
  return (
    <>
      <div className="peek-head"><span className="mono">{value.id}</span>
        <span className="peek-dim">{[value.type, value.status.replace(/_/g, " "), value.priority !== undefined ? `P${value.priority}` : null].filter(Boolean).join(" · ")}</span></div>
      <div className="peek-title">{value.title}</div>
      {value.description && <div className="peek-text">{value.description.split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 280)}</div>}
    </>
  );
}

function CommitPeek({ sha }: { sha: string }) {
  const { value, failed } = useHost<{ short: string; author: string; when: string; subject: string; files: Array<{ rel: string; added: number; removed: number }> }>(`/api/commit/${sha}`);
  if (!value) return <Loading failed={failed} />;
  return (
    <>
      <div className="peek-head"><span className="mono">{value.short}</span><span className="peek-dim">{value.author}, {value.when}</span></div>
      <div className="peek-title">{value.subject}</div>
      <div className="peek-files">
        {value.files.slice(0, 6).map((file) => <div key={file.rel}><span className="mono">{file.rel}</span><span><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span></div>)}
        {value.files.length > 6 && <div className="peek-dim">… {value.files.length - 6} more files</div>}
      </div>
    </>
  );
}

function Thumbnail({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Icon kind="file" />;
  return <img alt="" src={src} loading="lazy" onError={() => setFailed(true)} />;
}

// --- thumbnails ------------------------------------------------------------------------------

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff?)$/i;
const RESULT_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|heic|tiff?|pdf|html?|md)$/i;

/** A picture of a file: in Agents Next the app makes it (QLThumbnailGenerator), so PDFs, pages
 *  and reports have one too; in a browser only images have one. */
export function thumbnailURL(host: ChipHost, path: string, size = 256, version = ""): string | undefined {
  if (host.inApp) return `agents-next-thumbnail://thumbnail?path=${encodeURIComponent(path)}&size=${size}${version ? `&v=${encodeURIComponent(version)}` : ""}`;
  return IMAGE_EXTENSIONS.test(path) ? host.rawURL(`/api/raw?path=${encodeURIComponent(path)}`) : undefined;
}

/** The names in an answer that could be result files (images, PDFs, pages, reports). */
export function resultNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)|(?:^|\s)((?:[\w.~-]+\/)*[\w.-]+\.[A-Za-z]{2,5})(?=[\s,.;:)]|$)/gm)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/^file:\/\//, "");
    if (RESULT_EXTENSIONS.test(name.replace(/[:#].*$/, ""))) names.add(name);
  }
  return [...names];
}

/** The turn's results as pictures: files named or linked in the answer, and images the turn
 *  made; one entry per file, at most four, then "+N". A markdown file is a result only when the
 *  turn wrote it: one the agent just mentions is a chip in the text. */
export function ResultStrip({ answer, changes, version }: { answer: string; changes: FileChange[]; version: string }) {
  const host = useContext(ChipHostContext);
  const names = useMemo(() => resultNames(answer).filter((name) => {
    const bare = name.replace(/[:#].*$/, "");
    return !/\.md$/i.test(bare) || changes.some((change) => change.path === bare || change.path.endsWith(`/${bare.replace(/^\.?\//, "")}`));
  }), [answer, changes]);
  const made = changes.filter((change) => IMAGE_EXTENSIONS.test(change.path)).map((change) => change.path);
  return <ResolvedStrip names={names} made={made} host={host} version={version} />;
}

function ResolvedStrip({ names, made, host, version }: { names: string[]; made: string[]; host: ChipHost | null; version: string }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const key = `${names.join("\n")}|${made.join("\n")}`;
  useEffect(() => {
    if (!host) return;
    let live = true;
    const ask = names.length > 0
      ? host.hostJson<{ resolved: Record<string, ChipTarget | null> }>("/api/resolve", { names }).then((value) => value.resolved, () => ({}) as Record<string, ChipTarget | null>)
      : Promise.resolve({} as Record<string, ChipTarget | null>);
    void ask.then((found) => {
      if (!live) return;
      const files = names.map((name) => found[name]).flatMap((target) => (target && (target.kind === "file" || target.kind === "image") && RESULT_EXTENSIONS.test(target.path) ? [target.path] : []));
      setPaths([...new Set([...files, ...made])]);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, host]);
  const open = useCallback((path: string, rel: string) => host?.open({ kind: "image", path, rel }, { alternate: false }), [host]);
  if (!host || !paths || paths.length === 0) return null;
  const shown = paths.slice(0, 4);
  return (
    <div className="strip">
      {shown.map((path) => {
        const rel = path.startsWith(`${host.cwd}/`) ? path.slice(host.cwd.length + 1) : path.split("/").pop()!;
        const src = thumbnailURL(host, path, 256, version);
        return (
          <figure key={path} className="snap" onClick={() => open(path, rel)} title={rel}>
            <div className="mini"><Thumbnail src={src} /></div>
            <figcaption>{rel.split("/").pop()}</figcaption>
          </figure>
        );
      })}
      {paths.length > 4 && <div className="snap more">+{paths.length - 4}</div>}
    </div>
  );
}
