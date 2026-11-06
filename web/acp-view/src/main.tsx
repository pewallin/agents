// The ACP view of one agent pane, for any agent. The page address names the session
// (/thread/<id>) and carries the pane's token in its fragment (#token=...); the page asks the
// host which agent it serves, connects to the adapter the host starts for this client, loads
// that session and shows it. No agent or session picker and no header: the pane decides what is
// shown, and the app's pane header names the agent.
//
// The look: a reading column, the agent's text straight on the page, its work as quiet gray lines
// that open on demand, one floating field to write in.
import { StrictMode, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { CannotLoadSession, OpenElsewhere, connectSession, type AcpSession } from "./acp-connection";
import { errorDetail } from "./errors";
import { attention, emptySession, reduce, type PermissionRequest, type SessionAction, type SessionState, type ToolCall } from "./session-state";
import { buildTurns, changesOf, describeCall, duration, oneLine, shortPath, toolOutput, type FileChange, type Step, type Turn } from "./turns";
import { ReviewPane } from "./review";
import { quoted } from "./compose";
import "./view.css";

// Markdown (Streamdown) and code highlighting load after the first paint.
const Markdown = lazy(() => import("./markdown"));

const started = performance.now();
const timings: Record<string, number> = {};
(window as unknown as { __acpTimings: typeof timings }).__acpTimings = timings;
function mark(name: string) {
  if (timings[name] === undefined) timings[name] = Math.round(performance.now() - started);
}

export interface HostInfo {
  cwd: string;
  agent: { id: string; name: string };
}

const useSession = create<SessionState & { dispatch: (action: SessionAction) => void }>((set) => ({
  ...emptySession(),
  dispatch: (action) => set((state) => reduce(state, action)),
}));
// For inspection and tests: the session's state, and a way to put a state in front of the view.
(window as unknown as { __acpState: () => SessionState }).__acpState = () => useSession.getState();
(window as unknown as { __acpDispatch: (action: SessionAction) => void }).__acpDispatch = (action) => useSession.getState().dispatch(action);

function readToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  try {
    if (fromHash) sessionStorage.setItem("acp-token", fromHash);
    return fromHash ?? sessionStorage.getItem("acp-token");
  } catch {
    return fromHash;
  }
}

const sessionId = decodeURIComponent(location.pathname.match(/^\/thread\/([^/]+)/)?.[1] ?? "") || null;
const token = readToken();
const themeParam = new URLSearchParams(location.search).get("theme");
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
/** In Agents Next the app sets the look (data-theme and the rest, see view.css) before the page
 *  loads and on every change; in a browser the page follows the system. */
const IN_APP = () => document.documentElement.dataset.agentsNext === "native";
const applyTheme = () => {
  if (IN_APP()) return;
  document.documentElement.dataset.theme = themeParam === "dark" || themeParam === "light"
    ? themeParam
    : darkQuery?.matches ? "dark" : "light";
};
applyTheme();
darkQuery?.addEventListener?.("change", applyTheme);

/** A clock for what is shown while the agent works; ticks once a second only while needed. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Chevron({ className = "chev" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
function Down() {
  return <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

/** The scroll position as a thumb that shows while the page scrolls and fades a second after,
 *  and can be dragged. The native one stays on screen where scroll bars always show. */
function ScrollThumb({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const thumb = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ top: number; height: number } | null>(null);
  const [shown, setShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      if (scrollHeight <= clientHeight + 1) { setGeometry(null); return; }
      const height = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
      const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
      setGeometry({ top, height });
    };
    const onScroll = () => {
      measure();
      setShown(true);
      clearTimeout(hide);
      hide = setTimeout(() => setShown(false), 1000);
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => { element.removeEventListener("scroll", onScroll); observer.disconnect(); clearTimeout(hide); };
  }, [target]);
  if (!geometry) return null;
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = target.current;
    if (!element) return;
    event.preventDefault();
    const startY = event.clientY;
    const startTop = element.scrollTop;
    const ratio = (element.scrollHeight - element.clientHeight) / (element.clientHeight - geometry.height);
    setDragging(true);
    const move = (moveEvent: PointerEvent) => { element.scrollTop = startTop + (moveEvent.clientY - startY) * ratio; };
    const up = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={thumb} className={`thumb${shown ? " on" : ""}${dragging ? " drag" : ""}`}
      style={{ top: geometry.top, height: geometry.height }} onPointerDown={onPointerDown} aria-hidden="true" />
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="notice">{children}</div>;
}

interface HostDiagnosticsReport {
  agent?: { id: string; name: string };
  agentInfo?: unknown;
  agentsCLI?: string;
  log?: string[];
  messages?: string[];
  [key: string]: unknown;
}

/** What went wrong, as the agent and the host say it, with the diagnostics to send on. */
function ErrorNotice({ title, error, agentName, onRetry }: {
  title: string;
  error: { message: string; data?: string };
  agentName: string;
  onRetry?: () => void;
}) {
  const [report, setReport] = useState<HostDiagnosticsReport | null>(null);
  const [hostGone, setHostGone] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    hostJson<HostDiagnosticsReport>("/api/diagnostics").then(
      (value) => { setReport(value); setHostGone(false); },
      () => { setReport(null); setHostGone(true); },
    );
  }, [error]);
  // The agent's own last words: what its adapter printed on stderr (logged as "agent <pid>: …").
  const stderr = (report?.log ?? []).filter((line) => / agent \d+: /.test(line)).slice(-12)
    .map((line) => line.replace(/^\S+ agent \d+: /, ""));
  const copy = async () => {
    const latest = await hostJson<HostDiagnosticsReport>("/api/diagnostics").catch(() => report);
    const text = JSON.stringify({
      view: { page: `${location.origin}${location.pathname}`, at: new Date().toISOString(), userAgent: navigator.userAgent },
      error: { title, ...error },
      ...(latest ?? { host: "did not answer" }),
    }, null, 2);
    // A host that does not answer has nothing to add; in the app, the app adds what the host
    // left on disk (its log, its metadata) and copies the lot.
    if (!latest && OPEN_REVIEW_BESIDE) {
      location.href = `agents-next-action://copy-acp-diagnostics#${btoa(unescape(encodeURIComponent(text)))}`;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="notice error-notice">
      <div className="err">
        <strong>{title}</strong>
        <div>{error.message}</div>
        {error.data && <pre>{error.data}</pre>}
        {stderr.length > 0 && (<><div className="d">Last output from {agentName}:</div><pre>{stderr.join("\n")}</pre></>)}
        <div className="acts">
          {hostGone && OPEN_REVIEW_BESIDE && (
            <button type="button" className="link" onClick={() => { location.href = "agents-next-action://restart-view-host"; }}>Restart view host</button>
          )}
          {onRetry && <button type="button" className="link" onClick={onRetry}>Reconnect</button>}
          <button type="button" className="link" onClick={() => void copy()}>{copied ? "Copied" : "Copy diagnostics"}</button>
        </div>
      </div>
    </div>
  );
}

const PRESENT: Record<string, string> = {
  "Read": "Reading", "Edited": "Editing", "Searched": "Searching", "Ran": "Running", "Fetched": "Fetching",
  "Thought": "Thinking", "Deleted": "Deleting", "Moved": "Moving", "Switched mode": "Switching mode",
};

function ToolLine({ call, cwd }: { call: ToolCall; cwd: string }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = describeCall(call, cwd);
  const output = toolOutput(call);
  const diffCount = call.content.some((entry) => entry.type === "diff");
  let meta: ReactNode = null;
  if (call.status === "failed") meta = <span className="del">failed</span>;
  else if (diffCount) {
    let added = 0;
    let removed = 0;
    for (const change of changesForCall(call)) { added += change.added; removed += change.removed; }
    meta = <><span className="add">+{added}</span> <span className="del">−{removed}</span></>;
  } else if (call.startedAt !== undefined && call.endedAt !== undefined && call.kind === "execute") {
    meta = duration(call.endedAt - call.startedAt).replace(/^0 s$/, "< 1 s");
  }
  // The row shows one line of the command or title; a longer one opens in full.
  const line = oneLine(target.replace(/`([^`]*)`/g, "$1"));
  const whole = line !== target.trim() ? target : null;
  const canOpen = Boolean(output) || whole !== null;
  return (
    <>
      <div className={`ln${canOpen ? " can-open" : ""}`} onClick={() => canOpen && setOpen(!open)} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined}
        onKeyDown={(event) => { if (canOpen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(!open); } }}>
        {verb && <span className="v">{verb}</span>}
        <span className="t" title={whole ? undefined : line}>{line}</span>
        {meta !== null && <span className="m">{meta}</span>}
      </div>
      {open && whole && <pre className="out cmd">{whole}</pre>}
      {open && output && <pre className="out">{output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output}</pre>}
    </>
  );
}

function changesForCall(call: ToolCall): FileChange[] {
  return changesOf([call]);
}

function StepLine({ step, cwd }: { step: Step; cwd: string }) {
  // Thinking and what the agent says along the way are markdown, as its answers are: Codex's
  // reasoning headers (**Checking row counts**) are a quiet bold line, `code` is code.
  if (step.type === "thought" || step.type === "remark") {
    return (
      <div className={step.type === "thought" ? "think" : "remark"}>
        <Suspense fallback={<p>{step.text}</p>}><Markdown text={step.text} streaming={false} /></Suspense>
      </div>
    );
  }
  return <ToolLine call={step.call} cwd={cwd} />;
}

function Activity({ turn, working, stopped, cwd }: { turn: Turn; working: boolean; stopped: boolean; cwd: string }) {
  const [open, setOpen] = useState(false);
  const timed = turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt - turn.startedAt >= 1000;
  if (turn.steps.length === 0) {
    return stopped && !working ? <div className="stopped">Stopped{timed ? ` after ${duration(turn.endedAt! - turn.startedAt!)}` : ""}</div> : null;
  }
  const isOpen = working || open;
  const label = working
    ? "Working"
    : stopped
      ? `Stopped${timed ? ` after ${duration(turn.endedAt! - turn.startedAt!)}` : ""}`
      : timed
        ? `Worked for ${duration(turn.endedAt! - turn.startedAt!)}`
        : `Worked, ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}`;
  return (
    <details className="quiet" open={isOpen} onToggle={(event) => { if (!working) setOpen((event.target as HTMLDetailsElement).open); }}>
      <summary>{label} <Chevron /></summary>
      <div className="trail">
        {turn.steps.map((step) => <StepLine key={`${step.type}-${step.id}`} step={step} cwd={cwd} />)}
      </div>
    </details>
  );
}

function EditsLine({ changes, onReview, cwd }: { changes: FileChange[]; onReview: () => void; cwd: string }) {
  if (changes.length === 0) return null;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div className="edits">
      <span>{changes.length === 1 ? `1 file changed` : `${changes.length} files changed`}</span>
      <span className="n"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      <span className="files">{changes.slice(0, 4).map((change) => <span key={change.path} title={change.path}>{shortPath(change.path, cwd)}</span>)}</span>
      <button className="tbtn" type="button" onClick={onReview}>Review</button>
    </div>
  );
}

/** How tall a message of yours stands before it folds: six lines, never more than 400px. */
const FOLDED_LINES = 6;
const FOLDED_MAX_PX = 400;

/** A message you sent. A long one folds to its first lines, fading into the bubble, as in Claude;
 *  Show more opens it. */
/** A time as the view shows it: HH:MM, local. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function YouMessage({ text, pending, at }: { text: string; pending?: boolean; at?: number }) {
  const body = useRef<HTMLDivElement>(null);
  const [folds, setFolds] = useState(false);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(FOLDED_MAX_PX);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 22;
      const folded = Math.min(Math.round(lineHeight * FOLDED_LINES), FOLDED_MAX_PX);
      setLimit(folded);
      // A line or two more than the fold is not worth a toggle.
      setFolds(element.scrollHeight > folded + lineHeight * 1.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  const folded = folds && !open;
  return (
    // The time shows on hover, as in Claude; a message replayed from the session's history has
    // none (the agent does not say when it was sent), so it shows none rather than a wrong one.
    <div className={`you${pending ? " pending" : ""}${folds ? " folds" : ""}${folded ? " folded" : ""}`}>
      {at !== undefined && <span className="when you-when">{clockTime(at)}</span>}
      <div ref={body} className="you-body" style={folded ? { maxHeight: limit } : undefined}>{text}</div>
      {folds && (
        <button type="button" className="you-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function TurnView({ turn, last, working, cwd, onReview }: { turn: Turn; last: boolean; working: boolean; cwd: string; onReview: (turn: Turn) => void }) {
  const streaming = last && working;
  const stopped = useSession((s) => s.stoppedTurns?.includes(turn.id) ?? false);
  return (
    <>
      {turn.user && (turn.user.external
        ? <div className="you external">Sent from the terminal</div>
        : <YouMessage text={turn.user.text} pending={turn.user.local} at={turn.user.at} />)}
      <Activity turn={turn} working={streaming && turn.answer.length === 0} stopped={stopped} cwd={cwd} />
      {turn.answer.length > 0 && (
        <div className="say">
          {turn.answer.map((item, index) => (
            <Suspense key={item.id} fallback={<p className="plain">{item.text}</p>}>
              <Markdown text={item.text} streaming={streaming && index === turn.answer.length - 1} />
            </Suspense>
          ))}
        </div>
      )}
      {!streaming && <EditsLine changes={turn.changes} cwd={cwd} onReview={() => onReview(turn)} />}
      {/* When the turn ended, quietly, for a turn the view saw happen. */}
      {!streaming && turn.endedAt !== undefined && turn.answer.length > 0 && <div className="when turn-when">{clockTime(turn.endedAt)}</div>}
    </>
  );
}

/** The step the agent is on, as one shimmering line. */
function CurrentStep({ turn, now, cwd }: { turn: Turn | undefined; now: number; cwd: string }) {
  const step = turn?.steps.at(-1);
  let text = "Thinking";
  let since = turn?.startedAt;
  if (turn && turn.answer.length > 0) text = "Writing";
  else if (step?.type === "tool" && step.call.status !== "completed" && step.call.status !== "failed") {
    const { verb, target } = describeCall(step.call, cwd);
    text = `${PRESENT[verb] ?? verb} ${target}`.trim();
    since = step.call.startedAt ?? since;
  }
  return (
    <div className="current">
      <span className="shim"><span className="txt">{text}</span>{since !== undefined && <span className="m">{duration(now - since)}</span>}</span>
    </div>
  );
}

function optionLabel(option: PermissionRequest["options"][number], agentName: string, call: PermissionRequest["toolCall"]): ReactNode {
  const command = commandOf(call);
  switch (option.kind) {
    case "allow_once": return "Yes";
    case "allow_always": return command ? <>Yes, and don't ask again for <code>{command.split(" ").slice(0, 2).join(" ")}</code></> : "Yes, and don't ask again";
    case "reject_once": return `No, and tell ${agentName} what to do instead`;
    case "reject_always": return "No, never";
    default: return option.name;
  }
}

function commandOf(call: PermissionRequest["toolCall"]): string | undefined {
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  if (Array.isArray(input.command)) return input.command.join(" ");
  if (typeof input.command === "string") return input.command;
  return undefined;
}

function Ask({ request, agentName, session, focused, cwd }: { request: PermissionRequest; agentName: string; session: AcpSession; focused: boolean; cwd: string }) {
  const [selected, setSelected] = useState(0);
  const isPlan = request.toolCall.kind === "switch_mode";
  const command = commandOf(request.toolCall);
  const files = (request.toolCall.locations ?? []).map((location) => shortPath(location.path, cwd));
  const question = isPlan
    ? `Should ${agentName} carry out the plan?`
    : request.toolCall.kind === "edit" && files.length > 0
      ? `May ${agentName} edit ${files.join(", ")}?`
      : command ? `May ${agentName} run this?` : `May ${agentName} go on?`;
  const detail = command ?? (isPlan ? undefined : request.toolCall.title ?? undefined);
  const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind.startsWith("reject"));

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value.length > 0;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= request.options.length) {
        event.preventDefault();
        session.answerPermission(request.id, request.options[digit - 1].optionId);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : request.options.length - 1)) % request.options.length);
      } else if (event.key === "Enter" && target?.tagName !== "TEXTAREA") {
        event.preventDefault();
        session.answerPermission(request.id, request.options[selected].optionId);
      } else if (event.key === "Escape") {
        event.preventDefault();
        session.answerPermission(request.id, reject?.optionId ?? null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, request, selected, session, reject]);

  return (
    <div className={`ask${isPlan ? " plan" : ""}`} role="alertdialog" aria-label={question}>
      <span className="q">{question}</span>
      {detail && <span className="cmd">{detail}</span>}
      {command && request.toolCall.title && request.toolCall.title !== command && <span className="sub">{request.toolCall.title}</span>}
      <div className="choices">
        {request.options.map((option, index) => (
          <button key={option.optionId} type="button" className={`choice${index === selected ? " sel" : ""}`}
            onMouseEnter={() => setSelected(index)}
            onClick={() => session.answerPermission(request.id, option.optionId)}>
            <span className="k2">{index + 1}</span>{optionLabel(option, agentName, request.toolCall)}
          </button>
        ))}
      </div>
    </div>
  );
}

interface MentionHit { kind: "file" | "pane"; path: string; note?: string }

async function hostJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`host answered ${response.status}`);
  return response.json() as Promise<T>;
}

/** What @ can add: the project's files, and the other panes of the pane's tmux session. */
function useMentionSearch(query: string | null): MentionHit[] {
  const [hits, setHits] = useState<MentionHit[]>([]);
  const panes = useRef<Promise<Array<{ id: string; command: string; title: string }>> | null>(null);
  useEffect(() => {
    if (query === null || !token) { setHits([]); panes.current = null; return; }
    panes.current ??= hostJson<{ panes: Array<{ id: string; command: string; title: string }> }>("/api/panes")
      .then((value) => value.panes, () => []);
    let cancelled = false;
    const timer = setTimeout(() => {
      const lower = query.toLowerCase();
      Promise.all([
        hostJson<{ files: string[] }>(`/api/files?q=${encodeURIComponent(query)}`).then((value) => value.files, () => [] as string[]),
        panes.current!,
      ]).then(([files, paneList]) => {
        if (cancelled) return;
        const paneHits = paneList
          .filter((pane) => !lower || `${pane.id} ${pane.command} ${pane.title}`.toLowerCase().includes(lower))
          .slice(0, 4)
          .map((pane): MentionHit => ({ kind: "pane", path: pane.id, note: pane.title && pane.title !== pane.command ? `${pane.command} · ${pane.title}` : pane.command }));
        setHits([...files.slice(0, paneHits.length > 0 ? 6 : 8).map((path): MentionHit => ({ kind: "file", path })), ...paneHits]);
      });
    }, 60);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  return hits;
}

/** The @ word under the caret, if the caret is in one. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

function Ring({ percent }: { percent: number }) {
  const angle = Math.min(0.999, percent / 100) * 2 * Math.PI;
  const x = 7 + 5.4 * Math.sin(angle);
  const y = 7 - 5.4 * Math.cos(angle);
  return (
    <span className="ring" title="Context used">
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.6" />
        {percent > 0 && <path d={`M7 1.6A5.4 5.4 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`} fill="none" stroke="currentColor" strokeWidth="1.6" />}
      </svg>
      {Math.round(percent)} %
    </span>
  );
}

type SelectChoice = { value?: string; name: string; options?: Array<{ value: string; name: string }> };
const SHOWN_CATEGORIES = new Set(["mode", "model", "thought_level"]);

function Dock({ session, info, now, onHeight }: { session: AcpSession; info: HostInfo; now: number; onHeight: (height: number) => void }) {
  const [draft, setDraft] = useState("");
  const [flying, setFlying] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  // The conversation leaves room under its end for the field floating over it.
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
    observer.observe(element);
    onHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [onHeight]);
  // Quote in Reply, from the app's context menu: the selection goes into the field as a quote.
  useEffect(() => {
    const onQuote = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text ?? "";
      setDraft((current) => quoted(text, current));
      requestAnimationFrame(() => {
        const element = input.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      });
    };
    window.addEventListener("agents-next-quote", onQuote);
    return () => window.removeEventListener("agents-next-quote", onQuote);
  }, []);
  const [queue, setQueue] = useState<string[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [selectedHit, setSelectedHit] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  // The box fits its text after every change: typing, a paste, a cut or undo, and the clear after
  // sending. Up to 40% of the view, then it scrolls inside; empty, it is one line again.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    const limit = Math.max(80, Math.round(window.innerHeight * 0.4));
    element.style.height = `${Math.min(element.scrollHeight, limit)}px`;
    element.style.overflowY = element.scrollHeight > limit ? "auto" : "hidden";
  }, [draft]);
  const prompting = useSession((s) => s.prompting);
  const working = useSession((s) => attention(s) === "working");
  const asking = useSession((s) => s.permissions.length > 0);
  const configOptions = useSession((s) => s.configOptions);
  const modes = useSession((s) => s.modes);
  const usage = useSession((s) => s.usage);
  const turnStart = useSession((s) => {
    const last = [...s.items].reverse().find((item) => item.type === "user");
    return last?.at;
  });
  const hits = useMentionSearch(mention ? mention.query : null);
  const agentName = info.agent.name;

  // @path names a file, @%3 a pane: a file goes as a link, a pane as what it shows now.
  const blocksFor = useCallback(async (text: string): Promise<ContentBlock[]> => {
    const blocks: ContentBlock[] = [{ type: "text", text }];
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const path = match[1];
      if (/^%\d+$/.test(path)) {
        const shown = await hostJson<{ text: string }>(`/api/panes/${encodeURIComponent(path)}/text`).catch(() => null);
        if (shown) blocks.push({ type: "resource", resource: { uri: `tmux://pane/${path}`, mimeType: "text/plain", text: shown.text } });
      } else {
        blocks.push({ type: "resource_link", uri: `file://${info.cwd.replace(/\/$/, "")}/${path}`, name: path });
      }
    }
    return blocks;
  }, [info.cwd]);

  // A queued message goes once the turn ends.
  useEffect(() => {
    if (prompting || working || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void blocksFor(next).then((blocks) => session.prompt(blocks));
  }, [prompting, working, queue, session, blocksFor]);

  const submit = (how: "send" | "queue") => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMention(null);
    setFlying(true);
    setTimeout(() => setFlying(false), 360);
    if (how === "queue" && (prompting || working)) { setQueue((items) => [...items, text]); return; }
    void blocksFor(text).then((blocks) => (prompting || working ? session.steer(blocks) : session.prompt(blocks)));
  };

  const pick = (path: string) => {
    if (!mention) return;
    const caret = input.current?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mention.start)}@${path} ${draft.slice(caret)}`;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const position = mention.start + path.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  };

  const options = configOptions.filter((option) => option.type === "select" && (!option.category || SHOWN_CATEGORIES.has(option.category)));
  const showModes = modes && modes.availableModes.length > 1 && !configOptions.some((option) => option.category === "mode");
  const percent = usage && usage.size > 0 ? (usage.used / usage.size) * 100 : undefined;
  const busy = prompting || working;

  return (
    <div className="dock" ref={dock}>
      <div className="inner">
        <PlanLine />
        {mention && hits.length > 0 && (
          <div className="pop" role="listbox" aria-label="Add">
            {hits.map((hit, index) => (
              <div key={`${hit.kind}-${hit.path}`} style={{ display: "contents" }}>
                {(index === 0 || hits[index - 1].kind !== hit.kind) && <div className="gh">{hit.kind === "file" ? "Files" : "Panes"}</div>}
                <div role="option" aria-selected={index === selectedHit} className={`it${index === selectedHit ? " sel" : ""}`}
                  onMouseDown={(event) => { event.preventDefault(); pick(hit.path); }} onMouseEnter={() => setSelectedHit(index)}>
                  <span className="p">{hit.path}</span>{hit.note && <small>{hit.note}</small>}
                </div>
              </div>
            ))}
          </div>
        )}
        {queue.map((text, index) => <div className="qd" key={index}>{text} – sent when the turn is done</div>)}
        {busy && !asking && (
          <div className="status">
            <span>{turnStart !== undefined ? `Working for ${duration(now - turnStart)}` : "Working"}</span>
            <span className="sp" />
            <span><kbd>↵</kbd> steer · <kbd>⌥↵</kbd> queue · <kbd>esc</kbd> stop</span>
          </div>
        )}
        <form className="box" onSubmit={(event) => { event.preventDefault(); submit("send"); }}>
          <textarea
            ref={input}
            className="input"
            value={draft}
            rows={1}
            placeholder={busy ? `Steer ${agentName} while it works` : `Ask ${agentName}, @ for files and panes`}
            onChange={(event) => {
              setDraft(event.target.value);
              setMention(mentionAt(event.target.value, event.target.selectionStart ?? event.target.value.length));
              setSelectedHit(0);
            }}
            onKeyDown={(event) => {
              if (mention && hits.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedHit((index) => (index + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(hits[selectedHit].path); return; }
                if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit(event.altKey ? "queue" : "send");
              } else if (event.key === "Escape" && busy && !asking) {
                event.preventDefault();
                void session.cancel();
              }
            }}
          />
          <div className="row">
            <button className="icon" type="button" aria-label="Add a file" onClick={() => {
              const next = draft.endsWith(" ") || !draft ? `${draft}@` : `${draft} @`;
              setDraft(next);
              setMention({ start: next.length - 1, query: "" });
              input.current?.focus();
            }}>
              <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
            {showModes && (
              <label className="opt">
                {modes!.availableModes.find((mode) => mode.id === modes!.currentModeId)?.name ?? modes!.currentModeId} <Down />
                <select value={modes!.currentModeId} onChange={(event) => void session.setMode(event.target.value)} aria-label="Mode">
                  {modes!.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
                </select>
              </label>
            )}
            {options.map((option) => {
              if (option.type !== "select") return null;
              const choices: Array<{ value?: string; name: string }> = (option.options as SelectChoice[])
                .flatMap((entry): Array<{ value?: string; name: string }> => entry.options ?? [entry]);
              const current = choices.find((choice) => choice.value === option.currentValue)?.name ?? String(option.currentValue);
              return (
                <label className="opt" key={option.id} title={option.description ?? option.name}>
                  {current} <Down />
                  <select value={String(option.currentValue)} aria-label={option.name}
                    onChange={(event) => void session.setConfigOption(option.id, event.target.value)}>
                    {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
                  </select>
                </label>
              );
            })}
            <span className="sp" />
            {percent !== undefined && <Ring percent={percent} />}
            {busy && !draft.trim()
              ? <button className="go stop" type="button" aria-label="Stop" onClick={() => void session.cancel()}>
                  <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.3" fill="currentColor" /></svg>
                </button>
              : <SendButton ready={Boolean(draft.trim())} flying={flying} label={busy ? "Steer" : "Send"} />}
          </div>
        </form>
      </div>
    </div>
  );
}

/** Send, in ink: grey until there is something to send; the arrow flies off when it sends. */
function SendButton({ ready, flying, label }: { ready: boolean; flying: boolean; label: string }) {
  return (
    <button className={`go${ready ? "" : " off"}${flying ? " fly" : ""}`} type="submit" aria-label={label} disabled={!ready && !flying}>
      <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

function PlanLine() {
  const plan = useSession((s) => s.plan);
  if (plan.length === 0 || plan.every((entry) => entry.status === "completed")) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  return (
    <details className="quiet plan-line">
      <summary>Plan, {done} of {plan.length} done <Chevron /></summary>
      <ol className="plist">
        {plan.map((entry, index) => <li key={index} className={`plan-${entry.status}`}>{entry.content}</li>)}
      </ol>
    </details>
  );
}

function Conversation({ session, info }: { session: AcpSession; info: HostInfo }) {
  const items = useSession((s) => s.items);
  const toolCalls = useSession((s) => s.toolCalls);
  const title = useSession((s) => s.title);
  const permissions = useSession((s) => s.permissions);
  const state = useSession((s) => attention(s));
  const working = state === "working";
  const turns = useMemo(() => buildTurns({ items, toolCalls }), [items, toolCalls]);
  const now = useNow(working);
  const [review, setReview] = useState<FileChange[] | null>(null);
  const myReviews = useRef(new Set<string>());

  // Comments sent from a review this view opened beside the pane come back here as a message.
  useEffect(() => {
    if (!token) return;
    const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    // The agent's state as the app sees it (its hooks): a turn the TUI runs shows here too.
    const dispatch = useSession.getState().dispatch;
    const followAgentState = () => hostJson<{ agentState?: string | null }>("/api/state")
      .then((value) => dispatch({ type: "agentState", state: value.agentState ?? null }), () => {});
    void followAgentState();
    events.addEventListener("open", () => void followAgentState());
    events.addEventListener("agent-state", (event) => {
      const { state } = JSON.parse((event as MessageEvent<string>).data) as { state: string | null };
      dispatch({ type: "agentState", state });
    });
    events.addEventListener("send", (event) => {
      const { review: id, text } = JSON.parse((event as MessageEvent<string>).data) as { review: string; text: string };
      if (!myReviews.current.has(id)) return;
      const busy = attention(useSession.getState()) === "working";
      void (busy ? session.steer : session.prompt)([{ type: "text", text }]);
    });
    return () => events.close();
  }, [session]);

  /** In the app the review opens as a pane beside this one (/api/open-review, through the app's
   *  app-control); elsewhere, or when the app cannot, it opens in the view. */
  const openReview = async (changes: FileChange[]) => {
    if (!OPEN_REVIEW_BESIDE) { setReview(changes); return; }
    try {
      const created = await fetch("/api/review", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ changes, cwd: info.cwd, agentName: info.agent.name }),
      });
      if (created.ok) {
        const { id } = await created.json() as { id: string };
        myReviews.current.add(id);
        const opened = await fetch("/api/open-review", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (opened.ok) return;
      }
    } catch {
      // Falls back to the review in the view.
    }
    setReview(changes);
  };
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const main = useRef<HTMLDivElement>(null);
  const onDockHeight = useCallback((height: number) => {
    main.current?.style.setProperty("--dock-space", `${Math.round(height + 18)}px`);
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    document.title = title ? `${title} – ${info.agent.name}` : info.agent.name;
  }, [title, info.agent.name]);
  // Follow the conversation while it is read at the bottom; stay put while reading higher up.
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const lastTurn = turns.at(-1);
  return (
    <div className={`view${review ? " reviewing" : ""}`} data-acp-ready="true" data-attention={state}>
      <div className="main" ref={main}>
        <div className="scroll-wrap">
        <ScrollThumb target={scroller} />
        <div className="scroll under-dock" ref={scroller} onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}>
          <div className="col">
            {turns.length === 0 && <div className="empty">Nothing in the session yet. Write to {info.agent.name} below.</div>}
            {turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} last={index === turns.length - 1} working={working} cwd={info.cwd}
                onReview={(t) => void openReview(t.changes)} />
            ))}
            {working && permissions.length === 0 && <CurrentStep turn={lastTurn} now={now} cwd={info.cwd} />}
            {permissions.map((request, index) => (
              <Ask key={request.id} request={request} agentName={info.agent.name} session={session} focused={index === 0} cwd={info.cwd} />
            ))}
          </div>
        </div>
        </div>
        <Dock session={session} info={info} now={now} onHeight={onDockHeight} />
      </div>
      {review && (
        <ReviewPane changes={review} cwd={info.cwd} agentName={info.agent.name}
          onClose={() => setReview(null)}
          onSend={(text) => { setReview(null); void (working ? session.steer : session.prompt)([{ type: "text", text }]); }} />
      )}
    </div>
  );
}

/** The session the address names, or for /thread/current the one the pane's agent has open now:
 *  Codex's thread is known from the pane's app-server before its first prompt, though no hook has
 *  reported it yet. */
function SessionGate({ info }: { info: HostInfo }) {
  const [resolved, setResolved] = useState<{ id: string | null; persisted?: boolean; busy?: boolean; startsNew?: boolean; problem?: string } | null>(
    sessionId === "current" ? null : { id: sessionId },
  );
  useEffect(() => {
    if (sessionId !== "current") return;
    // An agent just started opens its session a moment after its host is up.
    const current = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await hostJson<{ sessionId: string | null; persisted?: boolean; busy?: boolean }>("/api/session");
        } catch (error) {
          if (attempt >= 60) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    };
    current().then(
      (value) => {
        // A hand-off agent whose TUI had no session yet: the view starts one.
        if (value.sessionId === null) { setResolved({ id: null, startsNew: true }); return; }
        setResolved({ id: value.sessionId, persisted: value.persisted !== false, busy: value.busy === true });
        // A reload opens the same thread, whatever the pane has open then.
        history.replaceState(null, "", `/thread/${encodeURIComponent(value.sessionId)}${location.search}${location.hash}`);
      },
      (error: unknown) => setResolved({ id: null, problem: error instanceof Error ? error.message : String(error) }),
    );
  }, []);
  // codex-acp does not follow a turn that is already running when it loads the thread.
  const waiting = resolved?.id && resolved.persisted !== false && resolved.busy ? resolved.id : null;
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    void untilIdle(waiting, () => stopped).then(() => { if (!stopped) setResolved({ id: waiting, persisted: true }); });
    return () => { stopped = true; };
  }, [waiting]);
  if (!resolved) return <Notice>Opening the session…</Notice>;
  if (resolved.startsNew) return <SessionView info={info} sessionId={null} />;
  if (!resolved.id) return <Notice>The pane has no {info.agent.name} session yet{resolved.problem ? ` (${resolved.problem})` : ""}.</Notice>;
  if (waiting) return <Notice>{info.agent.name} is working; the session shows when it is done.</Notice>;
  if (resolved.persisted === false) {
    return <FirstPrompt info={info} sessionId={resolved.id} onStarted={() => setResolved({ id: resolved.id, persisted: true })} />;
  }
  return <SessionView info={info} sessionId={resolved.id} />;
}

/** Waits until the pane's agent has no turn running on the session. */
async function untilIdle(sessionId: string, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await hostJson<{ sessionId: string; busy?: boolean }>("/api/session").catch(() => null);
    if (current && (current.sessionId !== sessionId || !current.busy)) return;
  }
}

/** A session with nothing in it yet (Codex writes a thread with its first turn): the first prompt
 *  starts the turn through the host, and then the view loads the session and follows it live. */
function FirstPrompt({ info, sessionId, onStarted }: { info: HostInfo; sessionId: string; onStarted: () => void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setProblem(null);
    try {
      const response = await fetch("/api/session/first-turn", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? `the host answered ${response.status}`);
      // The view follows turns that start once it has the session: it loads it when this one is done.
      await untilIdle(sessionId, () => false);
      onStarted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSending(false);
    }
  };
  return (
    <div className="view" data-acp-ready="true" data-attention={sending ? "working" : "idle"}>
      <div className="main">
        <div className="scroll-wrap"><div className="scroll"><div className="col">
          {sending && !problem && <div className="you">{draft}</div>}
          <div className="empty">{problem ? `The first prompt did not start: ${problem}` : sending ? `${info.agent.name} is working on it; the session shows when it is done.` : `Nothing in the session yet. Write to ${info.agent.name} below.`}</div>
        </div></div></div>
        <div className="dock"><div className="inner">
          <form className="box" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <textarea className="input" value={draft} rows={1} autoFocus disabled={sending}
              placeholder={`Ask ${info.agent.name}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
              }} />
            <div className="row">
              <span className="sp" />
              <button className={`go${draft.trim() && !sending ? "" : " off"}`} type="submit" aria-label="Send" disabled={!draft.trim() || sending}>
                <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </form>
        </div></div>
      </div>
    </div>
  );
}

/** The session, loaded and followed live; with no session given, one the view starts. */
function SessionView({ info, sessionId }: { info: HostInfo; sessionId: string | null }) {
  const dispatch = useSession((s) => s.dispatch);
  const [error, setError] = useState<{ title: string; detail: { message: string; data?: string } } | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const [takenOver, setTakenOver] = useState(false);
  const [cannotLoad, setCannotLoad] = useState<CannotLoadSession | null>(null);
  const [openElsewhere, setOpenElsewhere] = useState(false);
  // "Take over here" connects again, asking the host for the session another view has.
  const [takeOvers, setTakeOvers] = useState(0);
  const takeOverHere = () => { setOpenElsewhere(false); setTakenOver(false); setTakeOvers((count) => count + 1); };
  const [loaded, setLoaded] = useState(false);
  const session = useMemo(() => token
    ? connectSession({
      url: `ws://${location.host}/acp?token=${encodeURIComponent(token)}`,
      sessionId, cwd: info.cwd, agentId: info.agent.id, dispatch, takeOver: takeOvers > 0,
      onTakenOver: () => setTakenOver(true),
    })
    : null, [info.cwd, info.agent.id, dispatch, takeOvers, reconnects]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setError(null);
    setLoaded(false);
    session.load()
      .then((loadedSession) => {
        if (cancelled) return;
        // A reload opens the session the view started.
        if (!sessionId) history.replaceState(null, "", `/thread/${encodeURIComponent(loadedSession.sessionId)}${location.search}${location.hash}`);
        mark("loaded");
        setLoaded(true);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof CannotLoadSession) { setCannotLoad(reason); return; }
        if (reason instanceof OpenElsewhere) { session.close(); setOpenElsewhere(true); return; }
        setError({ title: "The session could not be opened", detail: errorDetail(reason) });
      });
    session.closed.then(
      () => { if (!cancelled) setError({ title: `The connection to ${info.agent.name} closed`, detail: { message: "The host ended the connection or the agent exited." } }); },
      (reason: unknown) => { if (!cancelled) setError({ title: `The connection to ${info.agent.name} broke`, detail: errorDetail(reason) }); },
    );
    return () => { cancelled = true; };
  }, [session, info.agent.name]);

  if (cannotLoad) {
    const version = cannotLoad.agentInfo?.version;
    // Copilot's changelog has ACP sessions resumed from 1.0.95 (0.0.406 cannot load one).
    const minimum = info.agent.id === "github-copilot-cli" ? "1.0.95 or later" : "a version that can";
    return (
      <Notice>
        <div>
          This {info.agent.name}{version ? ` (${version})` : ""} can't open its session in the web view: it cannot load an existing session (ACP <code>session/load</code>).
          <br />Update {info.agent.name} to {minimum}, or go on in the terminal.
        </div>
      </Notice>
    );
  }
  if (takenOver) {
    return (
      <Notice>
        <div>The session was taken over by another view. <button type="button" className="link" onClick={takeOverHere}>Take it back here</button></div>
      </Notice>
    );
  }
  if (openElsewhere) {
    return (
      <Notice>
        <div>The session is already open in another view. <button type="button" className="link" onClick={takeOverHere}>Take over here</button></div>
      </Notice>
    );
  }
  if (error) {
    return <ErrorNotice title={error.title} error={error.detail} agentName={info.agent.name}
      onRetry={() => setReconnects((count) => count + 1)} />;
  }
  if (!session || !loaded) return <Notice>Opening the session…</Notice>;
  return <Conversation session={session} info={info} />;
}

/** A review opened as a pane of its own (/review/<id>): its comments go back to the view that
 *  opened it, through the host. */
function ReviewPage({ id }: { id: string }) {
  const [review, setReview] = useState<{ changes: FileChange[]; cwd: string; agentName: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "sent" | "missing">("loading");
  useEffect(() => {
    hostJson<{ changes: FileChange[]; cwd: string; agentName: string }>(`/api/review/${encodeURIComponent(id)}`)
      .then((value) => { setReview(value); setState("ready"); document.title = `Changes – ${value.agentName}`; })
      .catch(() => setState("missing"));
  }, [id]);
  if (state === "missing") return <Notice>The review is gone. Open it again from the agent's view.</Notice>;
  if (!review) return <Notice>Opening the review…</Notice>;
  if (state === "sent") return <Notice>The comments were sent to {review.agentName}. The pane can be closed.</Notice>;
  return (
    <div className="view review-page">
      <ReviewPane changes={review.changes} cwd={review.cwd} agentName={review.agentName}
        onSend={(text) => {
          void fetch(`/api/review/${encodeURIComponent(id)}/send`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          }).then((response) => setState(response.ok ? "sent" : "missing"));
        }} />
    </div>
  );
}

/** The app shows the view with ?agents-next=acp-view; there a review gets a pane of its own. */
const OPEN_REVIEW_BESIDE = new URLSearchParams(location.search).get("agents-next") === "acp-view";
const reviewId = decodeURIComponent(location.pathname.match(/^\/review\/([^/]+)/)?.[1] ?? "") || null;

function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch("/api/info", { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`the host answered ${response.status}`))))
      .then((value: HostInfo) => { mark("info"); setInfo(value); })
      .catch((reason: Error) => setError(reason.message));
  }, []);
  if (!token) return <Notice>The page needs the pane's token. Open it from Agents Next.</Notice>;
  if (reviewId) return <ReviewPage id={reviewId} />;
  if (error) return <Notice>The pane's ACP host does not answer: {error}</Notice>;
  if (!info) return <Notice>Connecting…</Notice>;
  return <SessionGate info={info} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
