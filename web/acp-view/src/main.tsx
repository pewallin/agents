// The ACP view of one agent pane, for any agent. The page address names the session
// (/thread/<id>) and carries the pane's token in its fragment (#token=...); the page asks the
// host which agent it serves, connects to the adapter the host starts for this client, loads
// that session and shows it. No agent or session picker and no header: the pane decides what is
// shown, and the app's pane header names the agent.
//
// The look: a reading column, the agent's text straight on the page, its work as quiet gray lines
// that open on demand, one floating field to write in.
import { StrictMode, createContext, lazy, Suspense, useCallback, type ComponentProps, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { withDictation } from "./dictation";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import type { ContentBlock, PlanEntry, SessionConfigOption } from "@agentclientprotocol/sdk";
import { CannotLoadSession, OpenElsewhere, connectSession, type AcpSession, type AllowAll } from "./acp-connection";
import { choicesOf, currentName, modesLabel, settingLabel, settingTitle, splitOptions, withModels } from "./session-options";
import { errorDetail } from "./errors";
import { attention, emptySession, reduce, shownMessage, type PermissionRequest, type SentAttachment, type SessionAction, type SessionState, type ToolCall } from "./session-state";
import { buildTurns, changesOf, conversationChanges, describeCall, duration, exitCode, groupSteps, groupSummary, mergeChanges, oneLine, shortPath, thoughtSummary, toolOutput, type FileChange, type GitChange, type Step, type StepGroup, type Turn } from "./turns";
import { changeFor, Chip, ChipHostContext, fileTarget, NamedChip, PeekLayer, ResultStrip, SentAttachments, TurnChangesContext, type ChipHost, type ChipTarget } from "./chips";
import { ReviewPane } from "./review";
import { LinkedText } from "./blocks";
import { quoted } from "./compose";
import { attachmentBlocks, attachmentsFromURIs, readAttachment, type Attachment } from "./attachments";
import { AgentEventLine, BriefRow, DeliveryRow, WorkerLine } from "./coordination-view";
import { parseAgentCommand, parseDelivery, parseWorkerPrompt } from "./coordination";
import { allCommands, choiceFor, filterChoices, filterCommands, needsInput, optionTarget, slashDraft, viewCommandPicks, viewCommands, type Choice, type SlashCommand, type ViewCommandId } from "./slash";
import { filterConversations, openInLabel, pickConversation, relativeTime, type PaneConversation, type PaneHistory } from "./conversations";
import { canExpand, DETAIL_TITLES, endingFailure, failedCalls, lastLines, useOpenedSteps, nextDetailLevel, setOpened as setOpenedStep, storeDetailLevel, storedDetailLevel, turnSummary, type DetailLevel } from "./detail";
import { announceBridge, APP_ACTIONS, APP_HANDLERS, appHandler, definePageEntry, PAGE_ENTRIES, PAGE_EVENTS, type AppHandler } from "./bridge";
import { gateFromHost, initialGate, nextViewPhase, type GatePhase, type ViewPhase } from "./opening";
import { typedTicketTokens, useTicketRules } from "./tickets";
import { contextPercent, usageText, usageTitle, type SessionUsage } from "./usage";
import { planShown, planSummary, storedPlanOpen, storePlanOpen } from "./plan";
import { hostOutdated, outdatedHostAction, triedKey, viewBuild } from "./host-build";
import "./view.css";

announceBridge();

// Markdown (Streamdown) and code highlighting load beside the session, after the first paint:
// a conversation shows once both are there, so its text and code never show raw first.
let markdownModule: typeof import("./markdown") | null = null;
const markdownReady = import("./markdown").then(async (module) => { await module.ready; markdownModule = module; return module; });
const LazyMarkdown = lazy(() => markdownReady);
/** Markdown at once when it has loaded (no Suspense fallback for a frame), lazily before. */
function Markdown(props: ComponentProps<typeof LazyMarkdown>) {
  const Loaded = markdownModule?.default;
  return Loaded ? <Loaded {...props} /> : <LazyMarkdown {...props} />;
}

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
/** The agent's name as the host serves the page (acp-host.ts withAgentName): the first frame has it. */
const AGENT_NAME = document.querySelector<HTMLMetaElement>('meta[name="acp-agent"]')?.content || null;
/** The app showed its own "opening" frame before this page (waited=1): the page goes on showing
 *  it as it was, without fading its line in again. */
if (new URLSearchParams(location.hash.slice(1)).get("waited") === "1") document.documentElement.dataset.waited = "true";
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
    // The view opens at the end of the conversation: that first scroll shows no thumb.
    const quietUntil = performance.now() + 600;
    const onScroll = () => {
      measure();
      if (performance.now() < quietUntil) return;
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

/** What the view says while it opens: the session it loads, or the agent it starts. */
function openingText(name: string | null = AGENT_NAME): string {
  return sessionId && sessionId !== "current" ? "Loading the session…" : `Starting ${name ?? "the agent"}…`;
}

/**
 * The view while it opens: the field where it will be, empty, and one quiet line in it saying
 * what the view waits for. The conversation then comes in above the field and nothing moves.
 * Agents Next shows the same frame before the host is up (acpViewStartingHTML in
 * WorkspaceWebSurfaceView.swift), so its page and this one meet without a jump.
 */
function Opening({ text = openingText() }: { text?: string }) {
  return (
    <div className="view opening" data-acp-opening="true">
      <div className="main">
        <div className="scroll-wrap"><div className="scroll" /></div>
        <div className="dock"><div className="inner">
          <div className="box">
            <textarea className="input" rows={1} disabled tabIndex={-1}
              placeholder={AGENT_NAME ? `Ask ${AGENT_NAME}, @ for files and panes, / for commands` : ""} />
            <div className="row">
              <span className="icon" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </span>
              <span className="opening-line" role="status"><i className="pulse" />{text}</span>
              <span className="sp" />
              <span className="go off" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="M7 11.5v-9M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
            </div>
          </div>
        </div></div>
      </div>
    </div>
  );
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
      location.href = `${APP_ACTIONS.copyDiagnostics}#${btoa(unescape(encodeURIComponent(text)))}`;
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
            <button type="button" className="link" onClick={() => { location.href = APP_ACTIONS.restartViewHost; }}>Restart view host</button>
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
  "Thought": "Thinking", "Compacted": "Compacting", "Deleted": "Deleting", "Moved": "Moving", "Switched mode": "Switching mode",
};

/** How much of the work shows (⌃O): the level, and opening a command's output beside the pane. */
const DetailContext = createContext<{ level: DetailLevel; openOutput: (title: string, text: string) => void }>({ level: "steps", openOutput: () => {} });

/** How long a step or a run takes before its row says so. */
const NOTABLE_MS = 5000;

const FILE_KINDS = new Set(["read", "edit", "delete", "move"]);

function ToolLine({ call, cwd, failure = false }: { call: ToolCall; cwd: string; failure?: boolean }) {
  // An agent's own coordination command (spawn, send, report, close) shows as what it did.
  const agentEvent = call.kind === "execute" ? parseAgentCommand(commandOf(call) ?? "", toolOutput(call)) : null;
  if (agentEvent) return <AgentEventLine event={agentEvent} failed={call.status === "failed"} />;
  return <PlainToolLine call={call} cwd={cwd} failure={failure} />;
}

function PlainToolLine({ call, cwd, failure }: { call: ToolCall; cwd: string; failure: boolean }) {
  const { level, openOutput } = useContext(DetailContext);
  const host = useContext(ChipHostContext);
  const turnChanges = useContext(TurnChangesContext);
  // Open or closed is the reader's, kept by the step's id: updates and the step's end keep it.
  const chosen = useOpenedSteps((state) => state.opened[call.id]);
  const open = chosen ?? level === "everything";
  const setOpen = (value: boolean) => setOpenedStep(call.id, value);
  const { verb, target } = describeCall(call, cwd);
  const output = toolOutput(call);
  const diffCount = call.content.some((entry) => entry.type === "diff");
  const running = call.status === "pending" || call.status === "in_progress";
  let meta: ReactNode = null;
  const failed = call.status === "failed";
  if (failed) {
    const code = exitCode(call);
    meta = <span className="fail">failed{code !== null ? ` · exit ${code}` : ""}</span>;
  }
  else if (diffCount) {
    let added = 0;
    let removed = 0;
    const callChanges = changesForCall(call);
    for (const change of callChanges) { added += change.added; removed += change.removed; }
    const counts = <><span className="add">+{added}</span> <span className="del">−{removed}</span></>;
    // The counts open the changes, as a changed file's chip does (the turn's, which git counted
    // where it could, else this edit's); the file's chip in the row opens the file.
    const change = callChanges.length === 1 ? changeFor(turnChanges, callChanges[0].path) ?? callChanges[0] : undefined;
    meta = change && host
      ? <span className="counts" role="button" title="Show the changes" onClick={(event) => {
          event.stopPropagation();
          host.open(fileTarget(change.path, shortPath(change.path, cwd)), { alternate: false, change });
        }}>{counts}</span>
      : counts;
  } else if (call.startedAt !== undefined && call.endedAt !== undefined && call.kind === "execute") {
    // A time only where it says something: a step that took a while.
    if (call.endedAt - call.startedAt >= NOTABLE_MS) meta = duration(call.endedAt - call.startedAt);
  }
  // The row shows one line of the command or title; a longer one opens in full.
  const line = oneLine(target.replace(/`([^`]*)`/g, "$1"));
  const whole = line !== target.trim() ? target : null;
  const canOpen = canExpand(call, output, whole !== null);
  // The files a read or an edit acted on, as chips.
  const files = call.kind && FILE_KINDS.has(call.kind)
    ? [...new Set([...call.content.flatMap((entry) => (entry.type === "diff" ? [entry.path] : [])), ...call.locations.map((location) => location.path)])].slice(0, 3)
    : [];
  const title = call.kind === "execute" ? `${verb} ${line}` : line;
  return (
    <>
      <div className={`ln${canOpen ? " can-open" : ""}${failed ? " failed" : ""}${failure ? " failure" : ""}`} onClick={() => canOpen && setOpen(!open)} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined}
        onKeyDown={(event) => { if (canOpen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(!open); } }}>
        {failed && <span className="fail-dot" aria-label="failed" />}
        {verb && <span className="v">{verb}</span>}
        {files.length > 0
          ? <span className="t files">{files.map((path) => <NamedChip key={path} name={path} counts={false} fallback={<span>{shortPath(path, cwd)}</span>} />)}</span>
          : <span className="t" title={whole ? undefined : line}>{line}</span>}
        {canOpen && <Chevron />}
        {meta !== null && <span className="m">{meta}</span>}
      </div>
      {open && whole && <pre className="out cmd"><LinkedText text={whole} /></pre>}
      {open && output && <StepOutput text={output} running={running} onOpenBeside={() => openOutput(title, output)} />}
      {open && !output && <div className="out none">{running ? "Running · no output yet" : "No output"}</div>}
      {/* A failure is one line; its output opens on a click. The step under way shows its last lines
          on the running step's line below the steps, where they do not move the steps. */}
    </>
  );
}

/** A step's output, opened: while the step runs it grows as output comes and keeps its end in
 *  sight (unless the reader scrolled up in it); a click opens all of it beside the pane. */
function StepOutput({ text, running, onOpenBeside }: { text: string; running: boolean; onOpenBeside: () => void }) {
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  // A running step keeps its last 6000 characters in sight; a finished one its first.
  const shown = text.length <= 6000 ? text : running ? `…\n${text.slice(-6000)}` : `${text.slice(0, 6000)}\n…`;
  useLayoutEffect(() => {
    const element = box.current;
    if (element && running && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [shown, running]);
  return (
    <pre ref={box} className={`out${OPEN_REVIEW_BESIDE ? " can-beside" : ""}`} title={OPEN_REVIEW_BESIDE ? "Open beside the pane" : undefined}
      onScroll={(event) => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}
      onClick={() => OPEN_REVIEW_BESIDE && !window.getSelection()?.toString() && onOpenBeside()}><LinkedText text={shown} /></pre>
  );
}

const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A running step's last lines. When the step ends they fold away over a quarter of a second
 *  rather than vanish, so what is below does not jump (at once with Reduce Motion). */
function LiveTail({ text, running }: { text: string; running: boolean }) {
  const [shown, setShown] = useState(running);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (running) { setShown(true); setClosing(false); return; }
    if (!shown) return;
    if (REDUCED_MOTION) { setShown(false); return; }
    setClosing(true);
    const timer = setTimeout(() => { setShown(false); setClosing(false); }, 260);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  if (!shown) return null;
  return <pre className={`out tail${closing ? " closing" : ""}`} aria-hidden={closing}>{text}</pre>;
}

function changesForCall(call: ToolCall): FileChange[] {
  return changesOf([call]);
}

function StepLine({ step, cwd, live = false, whole = false }: { step: Step; cwd: string; live?: boolean; whole?: boolean }) {
  // Thinking and what the agent says along the way are markdown, as its answers are: Codex's
  // reasoning headers (**Checking row counts**) are a quiet bold line, `code` is code. Among the
  // steps both fold to one quiet line that opens on a click; Results (whole) shows only what the
  // agent says, so there it is shown whole.
  if (step.type === "thought") return <ThoughtLine step={step} live={live} />;
  if (step.type === "remark") {
    if (whole) {
      return (
        <div className="remark">
          <Suspense fallback={<p>{step.text}</p>}><Markdown text={step.text} streaming={live} fade={false} /></Suspense>
        </div>
      );
    }
    return <RemarkLine step={step} />;
  }
  return <ToolLine call={step.call} cwd={cwd} />;
}

/** Whether a one-line text is cut short (its ellipsis shows): then its row opens to show all of it. */
function useCutShort(text: string, shown = true): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const element = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const span = element.current;
    if (!span) return;
    // Not laid out (a folded turn, a row opened that hides it): nothing to measure, keep the last.
    const measure = () => { if (span.isConnected && span.clientWidth > 0) setCut(span.scrollWidth > span.clientWidth + 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(span);
    return () => observer.disconnect();
  }, [text, shown]);
  return [element, cut];
}

/** What the agent said between its steps (Kiro and Claude narrate their work this way): one quiet
 *  line of its first words; a click shows all of it, a click on that folds it again. */
function RemarkLine({ step }: { step: Extract<Step, { type: "remark" }> }) {
  const { level } = useContext(DetailContext);
  const chosen = useOpenedSteps((state) => state.opened[step.id]);
  const { title } = thoughtSummary(step.text);
  const opened = chosen ?? level === "everything";
  const [line, cut] = useCutShort(title, !opened);
  const canOpen = step.text.includes("\n") || step.text !== title || cut;
  const open = canOpen && opened;
  const toggle = () => {
    // A drag that selected text is a selection, not a click.
    if (!canOpen || window.getSelection()?.toString()) return;
    setOpenedStep(step.id, !open);
  };
  const keys = (event: React.KeyboardEvent) => { if (canOpen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(); } };
  if (open) {
    return (
      <div className="remark open" role="button" tabIndex={0} aria-expanded onClick={toggle} onKeyDown={keys}>
        <Suspense fallback={<p>{step.text}</p>}><Markdown text={step.text} streaming={false} fade={false} /></Suspense>
      </div>
    );
  }
  return (
    <div className="remark">
      <div className={`ln${canOpen ? " can-open" : ""}`} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined}
        aria-expanded={canOpen ? false : undefined} onClick={toggle} onKeyDown={keys}>
        <span className="tp" ref={line}>{oneLine(title, 200)}</span>
        {canOpen && <Chevron />}
      </div>
    </div>
  );
}

/** Thinking, as Claude and Codex show it: one quiet line (Codex's header or the first words, and
 *  how long it took) that opens on a click. Everything (⌃O) shows it open; the reader's choice is
 *  kept by its id, as a step's is. */
function ThoughtLine({ step, live }: { step: Extract<Step, { type: "thought" }>; live: boolean }) {
  const { level } = useContext(DetailContext);
  const chosen = useOpenedSteps((state) => state.opened[step.id]);
  const { title, body } = thoughtSummary(step.text);
  // A thought of one line that shows whole has nothing more to show.
  const opened = chosen ?? level === "everything";
  const [line, cut] = useCutShort(title, !(opened && body === step.text));
  const canOpen = body.length > 0 && (body.includes("\n") || body !== title || cut);
  const open = canOpen && opened;
  const toggle = () => canOpen && setOpenedStep(step.id, !open);
  const writing = live && step.endedAt === undefined;
  return (
    <div className={`think${open ? " open" : ""}`}>
      <div className={`ln${canOpen ? " can-open" : ""}`} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined}
        aria-expanded={canOpen ? open : undefined} onClick={toggle}
        onKeyDown={(event) => { if (canOpen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(); } }}>
        {/* Open, the first words are the text's own first line: shown once, in the text. */}
        {!(open && body === step.text) && <span className="tp" ref={line}>{oneLine(title, 140)}</span>}
        {canOpen && <Chevron />}
      </div>
      {open && (
        <div className="think-body">
          <Suspense fallback={<p>{body}</p>}><Markdown text={body} streaming={writing} fade={false} /></Suspense>
        </div>
      )}
    </div>
  );
}

/** What the agent is writing after its last step, in a turn under way: where it will stay if
 *  another step follows (a remark), in the same element, so the next step changes nothing about
 *  it. It becomes the answer below the steps when the turn ends. */
function LiveText({ items }: { items: Turn["answer"] }) {
  return (
    <>
      {items.filter((item) => item.text.trim()).map((item) => (
        <div key={`remark-${item.id}`} className="remark writing">
          <Suspense fallback={<p>{item.text}</p>}><Markdown text={item.text} streaming fade /></Suspense>
        </div>
      ))}
    </>
  );
}

/** A tool call that joins a run of them on one line: what only looks (commands, reads, searches),
 *  not an edit, whose file and counts show on its row, nor a coordination command. */
function groupable(call: ToolCall): boolean {
  if (call.kind === "edit" || call.kind === "delete" || call.kind === "move" || call.kind === "switch_mode") return false;
  return !(call.kind === "execute" && parseAgentCommand(commandOf(call) ?? ""));
}

/** Many tool calls in a row as one line, "Ran 12 commands · read 3 files", that opens to their
 *  rows. It stays one line while the run grows, so the steps below it do not move. */
function GroupLine({ group, cwd }: { group: StepGroup; cwd: string }) {
  const { level } = useContext(DetailContext);
  const chosen = useOpenedSteps((state) => state.opened[group.id]);
  const open = chosen ?? level === "everything";
  const toggle = () => setOpenedStep(group.id, !open);
  const failed = group.calls.filter((call) => call.status === "failed").length;
  const starts = group.calls.flatMap((call) => (call.startedAt !== undefined ? [call.startedAt] : []));
  const ends = group.calls.flatMap((call) => (call.endedAt !== undefined ? [call.endedAt] : []));
  const took = starts.length && ends.length && Math.max(...ends) - Math.min(...starts) >= NOTABLE_MS ? duration(Math.max(...ends) - Math.min(...starts)) : null;
  return (
    <div className={`group${open ? " open" : ""}`}>
      <div className="ln can-open" role="button" tabIndex={0} aria-expanded={open} onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}>
        <span className="v">{groupSummary(group.calls)}</span>
        {failed > 0 && <span className="gf">· {failed} failed</span>}
        <Chevron />
        {took && <span className="m">{took}</span>}
      </div>
      {open && <div className="group-body">{group.steps.map((step) => <StepLine key={`${step.type}-${step.id}`} step={step} cwd={cwd} />)}</div>}
    </div>
  );
}

function Activity({ turn, working, stopped, cwd }: { turn: Turn; working: boolean; stopped: boolean; cwd: string }) {
  const { level } = useContext(DetailContext);
  const [open, setOpen] = useState(false);
  const timed = turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt - turn.startedAt >= 1000;
  if (turn.steps.length === 0) {
    return stopped && !working ? <div className="stopped">Stopped{timed ? ` after ${duration(turn.endedAt! - turn.startedAt!)}` : ""}</div> : null;
  }
  // While the agent works the steps stay as they are, whatever it says between them: what it
  // writes after a step shows below them and joins them when the next step starts, so nothing
  // folds and unfolds under the reader. Results shows only what it says; Steps everything it does;
  // a finished turn folds into one line (Everything keeps it open).
  if (working && level === "results") {
    const remarks = turn.steps.filter((step) => step.type === "remark");
    return remarks.length > 0 || turn.answer.length > 0
      ? (
        <div className="trail remarks live-turn">
          {remarks.map((step) => <StepLine key={`${step.type}-${step.id}`} step={step} cwd={cwd} live whole />)}
          <LiveText items={turn.answer} />
        </div>
      )
      : null;
  }
  const isOpen = level === "everything" || (working && level === "steps") || open;
  const label = working
    ? "Working"
    : stopped ? `Stopped${timed ? ` after ${duration(turn.endedAt! - turn.startedAt!)}` : ""}` : turnSummary(turn);
  // Failures are counted on the folded line; only one the turn ended on shows outside it.
  const failedCount = working ? 0 : failedCalls(turn).length;
  const ending = isOpen || working ? null : endingFailure(turn);
  // Coordination (workers started, steered, reported to, closed) shows whatever the level.
  const coordinationCalls = isOpen ? [] : turn.steps.flatMap((step) =>
    step.type === "tool" && step.call.kind === "execute" && step.call.status !== "failed" && parseAgentCommand(commandOf(step.call) ?? "") ? [step.call] : []);
  return (
    <>
      <details className="quiet" open={isOpen} onToggle={(event) => { if (!working && level !== "everything") setOpen((event.target as HTMLDetailsElement).open); }}>
        <summary>{label}{failedCount > 0 && <span className="fail-count"> · {failedCount} failed</span>} <Chevron /></summary>
        <div className={`trail${working ? " live-turn" : ""}`}>
          {groupSteps(turn.steps, groupable, working).map((step) => step.type === "group"
            ? <GroupLine key={step.id} group={step} cwd={cwd} />
            : <StepLine key={`${step.type}-${step.id}`} step={step} cwd={cwd} live={working} />)}
          {working && <LiveText items={turn.answer} />}
        </div>
      </details>
      {coordinationCalls.length > 0 && (
        <div className="trail coordination">
          {coordinationCalls.map((call) => <ToolLine key={call.id} call={call} cwd={cwd} />)}
        </div>
      )}
      {ending && (
        <div className="trail failures">
          <ToolLine call={ending} cwd={cwd} failure />
        </div>
      )}
    </>
  );
}

/** After a turn: a check mark (drawn once, for a turn seen live), when it ended, what it changed,
 *  and Review, Commit and Undo. Commit and Undo ask the agent; the view runs no git. */
function Receipt({ turn, cwd, onReview, onSend }: { turn: Turn; cwd: string; onReview: () => void; onSend: (text: string) => void }) {
  const changes = turn.changes;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const live = turn.endedAt !== undefined;
  if (!live && changes.length === 0) return null;
  return (
    <div className={`receipt${live && Date.now() - turn.endedAt! < 4000 ? " draw" : ""}`}>
      <span className="done">
        <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4l2.6 2.6L11 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {live ? clockTime(turn.endedAt!) : "Done"}
      </span>
      {changes.length > 0 && (
        <>
          <span className="delta">{changes.length === 1 ? "1 file" : `${changes.length} files`} <span className="add">+{added}</span> <span className="del">−{removed}</span></span>
          <span className="files">
            {changes.slice(0, 4).map((change) => <Chip key={change.path} target={fileTarget(change.path, shortPath(change.path, cwd))} />)}
            {changes.length > 4 && <span className="more">+{changes.length - 4}</span>}
          </span>
          <span className="receipt-acts">
            <button className="pbtn" type="button" onClick={onReview}>Review</button>
            <button className="pbtn" type="button" onClick={() => onSend("Commit the changes you made in this turn, with a message that says what they do.")}>Commit</button>
            <button className="pbtn" type="button" onClick={() => onSend("Undo the changes you made in this turn.")}>Undo</button>
          </span>
        </>
      )}
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

/** Text you typed, with its ticket ids as their chips (tickets.ts). */
function TicketText({ text }: { text: string }) {
  const rules = useTicketRules();
  const tokens = useMemo(() => typedTicketTokens(text, rules), [text, rules]);
  if (tokens.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) parts.push(text.slice(at, token.start));
    parts.push(<Chip key={token.start} target={{ kind: "ticket", id: token.id, url: token.href }} label={text.slice(token.start, token.end)} />);
    at = token.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function YouMessage({ text, pending, at, attachments = [] }: { text: string; pending?: boolean; at?: number; attachments?: SentAttachment[] }) {
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
      {text && <div ref={body} className="you-body" style={folded ? { maxHeight: limit } : undefined}><TicketText text={text} /></div>}
      <SentAttachments attachments={attachments} />
      {folds && (
        <button type="button" className="you-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** What started a turn: your message, or what the coordination put there (a wake-up, a brief),
 *  or a turn started in the terminal (with its text when the agents CLI passed it on). */
function UserItem({ user }: { user: NonNullable<Turn["user"]> }) {
  const delivery = parseDelivery(user.text);
  if (delivery) return <DeliveryRow summary={delivery.summary} file={delivery.file} at={user.at} />;
  const brief = parseWorkerPrompt(user.text);
  if (brief) return <BriefRow task={brief.task} brief={brief.brief} prompt={user.text} respawn={brief.respawn} />;
  if (user.external) {
    return user.text
      ? <div className="you external with-text"><span className="from">From the terminal</span><TicketText text={user.text} /></div>
      : <div className="you external">Sent from the terminal</div>;
  }
  return <SentMessage user={user} />;
}

/** A message of ours, with what it attaches under it. */
function SentMessage({ user }: { user: NonNullable<Turn["user"]> }) {
  const shown = useMemo(() => shownMessage(user.text, user.attachments), [user.text, user.attachments]);
  return <YouMessage text={shown.text} pending={user.local && !user.answered} at={user.at} attachments={shown.attachments} />;
}

function TurnView({ turn, last, working, cwd, onReview, onSend }: { turn: Turn; last: boolean; working: boolean; cwd: string; onReview: (turn: Turn) => void; onSend: (text: string) => void }) {
  const streaming = last && working;
  const stopped = useSession((s) => s.stoppedTurns?.includes(turn.id) ?? false);
  const answerText = useMemo(() => turn.answer.map((item) => item.text).join("\n"), [turn.answer]);
  return (
    <TurnChangesContext.Provider value={turn.changes}>
      {turn.user && <UserItem user={turn.user} />}
      <Activity turn={turn} working={streaming} stopped={stopped} cwd={cwd} />
      {/* While the agent works after a step, what it writes is in the steps (Activity) until the turn ends. */}
      {turn.answer.length > 0 && !(streaming && turn.steps.length > 0) && (
        <div className="say">
          {turn.answer.map((item, index) => (
            <Suspense key={item.id} fallback={<p className="plain">{item.text}</p>}>
              {item.text && <Markdown text={item.text} streaming={streaming && index === turn.answer.length - 1} />}
              {item.images && item.images.length > 0 && (
                <div className="sent-images">
                  {item.images.map((image, imageIndex) => <img key={imageIndex} alt="" src={`data:${image.mimeType};base64,${image.data}`} />)}
                </div>
              )}
            </Suspense>
          ))}
        </div>
      )}
      {!streaming && answerText && <ResultStrip answer={answerText} changes={turn.changes} version={String(turn.endedAt ?? "")} />}
      {!streaming && (turn.answer.length > 0 || turn.changes.length > 0) && <Receipt turn={turn} cwd={cwd} onReview={() => onReview(turn)} onSend={onSend} />}
    </TurnChangesContext.Provider>
  );
}

/** The step the agent is on, as one shimmering line. */
function CurrentStep({ turn, now, cwd }: { turn: Turn | undefined; now: number; cwd: string }) {
  const { openOutput } = useContext(DetailContext);
  const step = turn?.steps.at(-1);
  let text = "Thinking";
  let since = turn?.startedAt;
  // The step under way opens here as in the steps: one open state for both, by its id. One the
  // reader opened stays here, open, when it ends, until the agent takes its next step.
  const last = turn && turn.answer.length === 0 && step?.type === "tool" ? step.call : null;
  const lastRunning = last !== null && last.status !== "completed" && last.status !== "failed";
  const lastOpen = useOpenedSteps((state) => (last ? state.opened[last.id] === true : false));
  const call = last && (lastRunning || lastOpen) ? last : null;
  const open = call !== null && lastOpen;
  if (turn && turn.answer.length > 0) text = "Writing";
  else if (call) {
    const { verb, target } = describeCall(call, cwd);
    text = `${lastRunning ? PRESENT[verb] ?? verb : verb} ${target}`.trim();
    since = lastRunning ? call.startedAt ?? since : since;
  }
  const output = call ? toolOutput(call) : "";
  const toggle = () => call && setOpenedStep(call.id, !open);
  return (
    <>
      <div className={`current${call ? " can-open" : ""}`} role={call ? "button" : undefined} tabIndex={call ? 0 : undefined}
        aria-expanded={call ? open : undefined} title={call ? (open ? "Hide the output" : "Show the command's output") : undefined}
        onClick={toggle} onKeyDown={(event) => { if (call && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(); } }}>
        <span className="shim"><span className="txt">{text}</span>{since !== undefined && <span className="m">{duration(now - since)}</span>}</span>
        {call && <Chevron />}
      </div>
      {/* A command that runs a while shows its last lines here, below the steps, so the steps
          above do not move as quick ones come and go. */}
      {call && !open && lastRunning && output && call.startedAt !== undefined && now - call.startedAt >= 2000 && (
        <div className="trail current-out tail-out"><LiveTail text={lastLines(output, 3).join("\n")} running /></div>
      )}
      {call && open && (
        <div className="trail current-out">
          {output
            ? <StepOutput text={output} running={lastRunning} onOpenBeside={() => openOutput(text, output)} />
            : <div className="out none">{lastRunning ? "Running · no output yet" : "No output"}</div>}
        </div>
      )}
    </>
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

function commandOf(call: { rawInput?: unknown }): string | undefined {
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
  const always = request.options.find((option) => option.kind === "allow_always");
  // For a git command, what it does in plain words, read from git (the view runs nothing).
  const [gitLine, setGitLine] = useState<string | null>(null);
  useEffect(() => {
    if (!command || !/^\s*git\s/.test(command)) return;
    let live = true;
    hostJson<{ summary: string | null }>(`/api/git/summary?command=${encodeURIComponent(command)}`).then((value) => { if (live) setGitLine(value.summary); }, () => {});
    return () => { live = false; };
  }, [command]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value.length > 0;
      if (typing || (event.metaKey && event.key !== "Enter") || event.ctrlKey || event.altKey) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= request.options.length) {
        event.preventDefault();
        session.answerPermission(request.id, request.options[digit - 1].optionId);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : request.options.length - 1)) % request.options.length);
      } else if (event.key === "Enter" && event.metaKey && always) {
        event.preventDefault();
        session.answerPermission(request.id, always.optionId);
      } else if (event.key === "Enter" && !event.shiftKey) {
        // ⏎ answers with the selected option, also from the field while it is empty.
        event.preventDefault();
        session.answerPermission(request.id, request.options[selected].optionId);
      } else if (event.key === "Escape") {
        event.preventDefault();
        session.answerPermission(request.id, reject?.optionId ?? null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, request, selected, session, reject, always]);

  return (
    <div className={`ask${isPlan ? " plan" : ""}`} role="alertdialog" aria-label={question}>
      <span className="q">{question}</span>
      {detail && <span className="cmd">{detail}</span>}
      {command && request.toolCall.title && request.toolCall.title !== command && <span className="sub">{request.toolCall.title}</span>}
      {gitLine && <span className="why">{gitLine}</span>}
      <div className="choices">
        {request.options.map((option, index) => (
          <button key={option.optionId} type="button" className={`choice${index === selected ? " sel" : ""}`}
            onMouseEnter={() => setSelected(index)}
            onClick={() => session.answerPermission(request.id, option.optionId)}>
            <span className="k2">{index + 1}</span><span className="lbl">{optionLabel(option, agentName, request.toolCall)}</span>
            <kbd>{index === selected ? "⏎" : option === always ? "⌘⏎" : option === reject ? "esc" : ""}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

interface MentionHit { kind: "file" | "pane"; path: string; note?: string }

/** A host's answer other than 200, with its message when it gave one. */
class HostAnswer extends Error {
  constructor(readonly status: number, readonly hostMessage?: string) {
    super(`host answered ${status}`);
  }
}

async function hostJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const message = ((await response.json().catch(() => ({}))) as { message?: unknown }).message;
    throw new HostAnswer(response.status, typeof message === "string" ? message : undefined);
  }
  return response.json() as Promise<T>;
}

// The app's context menu opens a link beside the pane through the view's host (Open Beside).
definePageEntry(PAGE_ENTRIES.openBeside, (url: string) => {
  void hostJson("/api/open-page", { url }).catch(() => window.open(url, "_blank"));
});

/** Sends a message to Agents Next, if the view is in it. */
function postToApp(handler: AppHandler, body: Record<string, unknown>): boolean {
  const target = appHandler(handler);
  if (!target) return false;
  target.postMessage(body);
  return true;
}

/** Whether the view is in Agents Next on the Mac, which takes the view's links and actions. */
function inMacApp(): boolean {
  return Boolean(appHandler(APP_HANDLERS.link));
}

/** Whether Agents Next opens another conversation in the pane for the view (/resume, /new): it
 *  runs the resume its Conversations runs, and the pane stays in the view. */
function conversationsInApp(): boolean {
  return Boolean(appHandler(APP_HANDLERS.conversation));
}

/** A conversation Agents Next is opening in the pane: the view says so, calmly, until the app
 *  shows the view of it (the pane's agent starts again, and its host with it). The app calls
 *  __agentsNextConversationFailed when it did not (with why, or null when it showed the pane that
 *  has the conversation), and the view is back as it was. */
const useOpeningConversation = create<{ text: string | null; failure: string | null }>(() => ({ text: null, failure: null }));
definePageEntry(PAGE_ENTRIES.conversationFailed, (message: string | null) => {
  useOpeningConversation.setState({ text: null, failure: message || null });
});

type DictationState = "idle" | "recording" | "transcribing";

/** Dictation by Agents Next: the field's microphone asks the app to record, the app's chosen
 *  transcription provider writes it down, and the words come back into the field. Its state and
 *  its text arrive as `agents-next-dictation` events; outside the app there is no microphone. */
function useAppDictation(onText: (text: string) => void): { available: boolean; state: DictationState; error: string | null; toggle: () => void } {
  const handler = appHandler(APP_HANDLERS.dictation);
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: DictationState; text?: string; error?: string }>).detail ?? {};
      if (detail.state) setState(detail.state);
      setError(detail.error ?? null);
      if (detail.text) onTextRef.current(detail.text);
    };
    window.addEventListener(PAGE_EVENTS.dictation, onEvent);
    return () => window.removeEventListener(PAGE_EVENTS.dictation, onEvent);
  }, []);
  return {
    available: Boolean(handler),
    state,
    error,
    toggle: () => handler?.postMessage({ action: "toggle" }),
  };
}

type SlashItem =
  | { kind: "command"; command: SlashCommand }
  | { kind: "choice"; choice: Choice; current: boolean }
  | { kind: "conversation"; conversation: PaneConversation }
  /** A line of the list that is not a choice: loading, nothing there. */
  | { kind: "status"; text: string };

/** The pane's conversations while /resume lists them, asked of the host each time it opens. */
function usePaneHistory(active: boolean): PaneHistory | { problem: string } | null {
  const [history, setHistory] = useState<PaneHistory | { problem: string } | null>(null);
  useEffect(() => {
    if (!active) { setHistory(null); return; }
    let cancelled = false;
    hostJson<PaneHistory>("/api/history?limit=50").then(
      (value) => { if (!cancelled) setHistory(value); },
      (error: unknown) => { if (!cancelled) setHistory({ problem: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
  }, [active]);
  return history;
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

interface QueuedMessage { id: string; text: string; at: string; state: "queued" | "offered" }

/** The pane's queue of messages for after the turn, as its host keeps it, kept current. A message
 *  the agent took from its steer inbox shows in the conversation as what you sent. */
function useHostQueue(): QueuedMessage[] {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const dispatch = useSession((s) => s.dispatch);
  useEffect(() => {
    if (!token) return;
    let live = true;
    hostJson<{ items: QueuedMessage[] }>("/api/queue").then((value) => { if (live) setItems(value.items); }, () => {});
    const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    events.addEventListener("queue", (event) => setItems((JSON.parse((event as MessageEvent<string>).data) as { items: QueuedMessage[] }).items));
    events.addEventListener("steered", (event) => {
      const { text } = JSON.parse((event as MessageEvent<string>).data) as { text: string };
      dispatch({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, at: Date.now() });
    });
    return () => { live = false; events.close(); };
  }, [dispatch]);
  return items;
}

/** How the agent takes a message during its turn: over ACP (Codex, Claude), through the pane's
 *  steer inbox (Pi, with the agents extension), or not at all (it waits for the turn's end). */
function useSteerWay(session: AcpSession): "acp" | "inbox" | "none" | undefined {
  const [way, setWay] = useState<"acp" | "inbox" | "none">();
  const working = useSession((s) => s.prompting || attention(s) === "working");
  useEffect(() => {
    let live = true;
    void session.steering().then(async (acp) => {
      if (acp) return "acp" as const;
      const inbox = await hostJson<{ inbox: boolean }>("/api/steer").then((value) => value.inbox, () => false);
      return inbox ? "inbox" as const : "none" as const;
    }).then((next) => { if (live) setWay(next); });
    return () => { live = false; };
    // The agent's extension says it takes steered messages once its session runs: look again
    // when a turn starts.
  }, [session, working]);
  return way;
}

/** The session's context, a ring of how full it is and its tokens, and what it has cost so far. */
function Usage({ usage }: { usage: SessionUsage }) {
  const percent = contextPercent(usage);
  const text = usageText(usage);
  if (!text) return null;
  const angle = Math.min(0.999, (percent ?? 0) / 100) * 2 * Math.PI;
  const x = 7 + 5.4 * Math.sin(angle);
  const y = 7 - 5.4 * Math.cos(angle);
  return (
    <span className="ring" title={usageTitle(usage)}>
      {percent !== undefined && (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.6" />
          {percent > 0 && <path d={`M7 1.6A5.4 5.4 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`} fill="none" stroke="currentColor" strokeWidth="1.6" />}
        </svg>
      )}
      <span className="rt">{text}</span>
    </span>
  );
}


function Dock({ session, info, now, onHeight, level, onCycleLevel }: {
  session: AcpSession; info: HostInfo; now: number; onHeight: (height: number) => void; level: DetailLevel; onCycleLevel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [flying, setFlying] = useState(false);
  // Files and images pasted or dropped into the field, sent with the message.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
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
    window.addEventListener(PAGE_EVENTS.quote, onQuote);
    return () => window.removeEventListener(PAGE_EVENTS.quote, onQuote);
  }, []);
  const dictation = useAppDictation((text) => {
    setDraft((current) => withDictation(current, text));
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  });
  // Messages for after the turn, kept by the pane's host (a reload keeps them, every view of the
  // pane shows the same), and how the agent takes a message during its turn.
  const queue = useHostQueue();
  const steerWay = useSteerWay(session);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
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
  const agentOptions = useSession((s) => s.configOptions);
  const models = useSession((s) => s.models);
  // An agent that offers its models in the session's `models` field (Kiro's v2 engine) gets the
  // same model picker as one with a model config option.
  const configOptions = useMemo(() => withModels(agentOptions, models), [agentOptions, models]);
  const modes = useSession((s) => s.modes);
  const usage = useSession((s) => s.usage);
  const turnStart = useSession((s) => {
    const last = [...s.items].reverse().find((item) => item.type === "user");
    return last?.at;
  });
  const hits = useMentionSearch(mention ? mention.query : null);
  const agentName = info.agent.name;

  // "/" at the start lists the agent's commands and the view's own; after a view command that
  // sets something, its choices.
  const agentCommands = useSession((s) => s.commands);
  const [caret, setCaret] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [selectedSlash, setSelectedSlash] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const commands = useMemo(
    () => allCommands(agentCommands, viewCommands({ configOptions, modes, inApp: inMacApp(), conversations: conversationsInApp() })),
    [agentCommands, configOptions, modes],
  );
  const slash = slashDraft(draft, caret);
  const slashCommand = slash?.stage === "args" ? commands.find((command) => command.name === slash.name) : undefined;
  const slashTarget = slashCommand?.view ? optionTarget(slashCommand.view, configOptions, modes) : null;
  const pickingConversation = !slashClosed && slash?.stage === "args" && slashCommand?.view === "resume";
  const history = usePaneHistory(pickingConversation);
  const conversationItems = (args: string): SlashItem[] => {
    if (!history) return [{ kind: "status", text: "Loading conversations…" }];
    if ("problem" in history) return [{ kind: "status", text: `The conversations could not be listed: ${history.problem}` }];
    const found = filterConversations(history.sessions, args);
    if (found.length > 0) return found.map((conversation): SlashItem => ({ kind: "conversation", conversation }));
    return [{ kind: "status", text: args.trim() ? `No conversation matches "${args.trim()}".` : `No earlier conversations with ${agentName} in this folder.` }];
  };
  const slashItems: SlashItem[] = slashClosed || !slash ? []
    : slash.stage === "name" ? filterCommands(commands, slash.query).map((command): SlashItem => ({ kind: "command", command }))
    : pickingConversation ? conversationItems(slash.args)
    : slashTarget ? filterChoices(slashTarget.choices, slash.args).map((choice): SlashItem => ({ kind: "choice", choice, current: choice.value === slashTarget.current }))
    : [];
  // The app could not open a conversation: the view is back, and says why.
  const openFailure = useOpeningConversation((s) => s.failure);
  useEffect(() => {
    if (!openFailure) return;
    setNotice(openFailure);
    useOpeningConversation.setState({ failure: null });
  }, [openFailure]);
  const slashHint = !slashClosed && slash?.stage === "args" && !slash.args && !slashTarget ? slashCommand?.hint : undefined;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // @path names a file, @%3 a pane: a file goes as a link, a pane as what it shows now.
  const blocksFor = useCallback(async (text: string): Promise<ContentBlock[]> => {
    const blocks: ContentBlock[] = [{ type: "text", text }];
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const path = match[1];
      if (/^%\d+$/.test(path)) {
        const shown = await hostJson<{ text: string }>(`/api/panes/${encodeURIComponent(path)}/text`).catch(() => null);
        if (shown) blocks.push({ type: "resource", resource: { uri: `tmux://pane/${path}`, mimeType: "text/plain", text: shown.text } });
      } else {
        const absolute = path.startsWith("/") ? path : `${info.cwd.replace(/\/$/, "")}/${path}`;
        blocks.push({ type: "resource_link", uri: `file://${absolute}`, name: path.split("/").pop() ?? path });
      }
    }
    return blocks;
  }, [info.cwd]);

  // A queued message goes once the turn ends, from the one view that takes it from the host.
  const taking = useRef(false);
  useEffect(() => {
    const next = queue.find((item) => item.state === "queued" && item.id !== editing?.id);
    if (prompting || working || !next || taking.current) return;
    taking.current = true;
    hostJson<{ item: QueuedMessage }>(`/api/queue/${next.id}/take`, {})
      .then(({ item }) => blocksFor(item.text).then((blocks) => session.prompt(blocks)), () => {})
      .finally(() => { taking.current = false; });
  }, [prompting, working, queue, editing, session, blocksFor]);

  const setField = (text: string) => {
    setDraft(text);
    setCaret(text.length);
    setSelectedSlash(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(text.length, text.length);
    });
  };

  /** Another conversation in the pane: the app opens it (as its Conversations does) and the pane
   *  stays in the view. An agent at work is not switched, as the view toggle does not. */
  const switchBlocked = prompting || working || asking;
  const busyLine = `${agentName} is working – switch conversations when it is done.`;
  const openConversation = (conversation: PaneConversation) => {
    const pick = pickConversation(conversation);
    if (pick.kind === "current") { setField(""); setNotice("That conversation is the one open here."); return; }
    if (pick.kind === "show") { setField(""); setNotice(null); postToApp(APP_HANDLERS.conversation, { action: "show", pane: pick.pane }); return; }
    if (pick.kind === "elsewhere") { setNotice(`That conversation is ${pick.label}: close it there to open it here.`); return; }
    if (switchBlocked) { setNotice(busyLine); return; }
    setField("");
    setNotice(null);
    useOpeningConversation.setState({ text: `Opening ${conversation.title}…`, failure: null });
    postToApp(APP_HANDLERS.conversation, {
      action: "open",
      agent: history && !("problem" in history) ? history.agent : undefined,
      sessionId: conversation.sessionId,
      title: conversation.title,
      resumeTarget: conversation.resumeTarget ?? conversation.sessionId,
      resumeTargetKind: conversation.resumeTargetKind ?? "session-id",
    });
  };

  /** Runs one of the view's own commands; a failed one keeps the field and says why. */
  const runView = (id: ViewCommandId, arg: string) => {
    const done = () => { setField(""); setNotice(null); };
    if (id === "resume") {
      // Enter with nothing in the list to pick: the list shows what is there.
      if (!arg.trim()) { setField(`/${slashCommand?.name ?? "resume"} `); return; }
      setNotice(`No conversation matches "${arg.trim()}".`);
      return;
    }
    if (id === "new") {
      if (switchBlocked) { setNotice(busyLine); return; }
      done();
      useOpeningConversation.setState({ text: "Starting a new conversation…", failure: null });
      postToApp(APP_HANDLERS.conversation, { action: "new" });
      return;
    }
    if (id === "terminal") {
      done();
      window.location.href = APP_ACTIONS.backToTerminal;
      return;
    }
    if (id === "changes") {
      let count = 0;
      window.dispatchEvent(new CustomEvent(PAGE_EVENTS.reviewConversation, { detail: { answer: (found: number) => { count = found; } } }));
      if (count === 0) { setNotice("Nothing has changed in this conversation yet."); return; }
      done();
      return;
    }
    const target = optionTarget(id, configOptions, modes);
    if (!target) { setNotice(`${agentName} has no ${id} to set.`); return; }
    const choice = choiceFor(target.choices, arg);
    if (!choice) {
      setNotice(arg.trim() ? `No ${id} called "${arg.trim()}". Pick one from the list.` : `Pick a ${id} from the list.`);
      setField(`/${id} `);
      return;
    }
    done();
    void (target.kind === "config" ? session.setConfigOption(target.id, choice.value) : session.setMode(choice.value));
  };

  /** Tab on a command puts it in the field; Enter also runs it when it needs nothing more. */
  const pickSlash = (item: SlashItem, run: boolean) => {
    if (item.kind === "status") return;
    if (item.kind === "conversation") { openConversation(item.conversation); return; }
    if (item.kind === "choice") { if (slashCommand?.view) runView(slashCommand.view, item.choice.value); return; }
    const { command } = item;
    const needsMore = command.view ? viewCommandPicks(command.view, optionTarget(command.view, configOptions, modes)) : needsInput(command);
    if (run && !needsMore) {
      if (command.view) runView(command.view, "");
      else sendText(`/${command.name}`, "send");
      return;
    }
    const space = draft.search(/\s/);
    setField(`/${command.name} ${space < 0 ? "" : draft.slice(space + 1)}`);
  };

  const submit = (how: "send" | "queue") => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const parsed = slashDraft(text, text.length);
    const command = parsed ? commands.find((entry) => entry.name === (parsed.stage === "name" ? parsed.query : parsed.name)) : undefined;
    if (command?.view) { runView(command.view, parsed?.stage === "args" ? parsed.args : ""); return; }
    // An agent's command waits for the turn to end: it is not something to steer the turn with.
    sendText(text, command ? "queue" : how);
  };

  const sendText = (typed: string, how: "send" | "queue") => {
    const attached = attachments;
    setAttachments([]);
    setField("");
    setNotice(null);
    setMention(null);
    setFlying(true);
    setTimeout(() => setFlying(false), 360);
    const save = (attachment: Attachment) => hostJson<{ path: string }>("/api/attachment", { name: attachment.name, data: attachment.data ?? "" }).then((value) => value.path);
    // The message with its attachments: images as images when the agent takes them, the rest as links.
    const withAttachments = async (text: string) => {
      const blocks = (await blocksFor(text)).filter((block) => block.type !== "text" || block.text.trim());
      if (attached.length === 0) return blocks;
      return [...blocks, ...await attachmentBlocks(attached, await session.promptCapabilities(), save)];
    };
    // A queued or inboxed message is text: its attachments go as @paths.
    const withPaths = async () => {
      const paths = await Promise.all(attached.map((attachment) => attachment.path ?? save(attachment)));
      return [typed, ...paths.map((path) => `@${path}`)].filter(Boolean).join(" ");
    };
    const failed = () => setNotice("The attachments could not be saved for the agent.");
    const enqueue = () => withPaths().then((text) => hostJson("/api/queue", { text })).catch(() => setNotice("The message could not be queued."));
    if (!(prompting || working)) { void withAttachments(typed).then((blocks) => session.prompt(blocks), failed); return; }
    if (how === "queue" || steerWay === "none") { void enqueue(); return; }
    if (steerWay === "acp") { void withAttachments(typed).then((blocks) => session.steer(blocks), failed); return; }
    // Through the pane's steer inbox (Pi): what the agent cannot take now waits for the turn's end.
    void withPaths().then((text) => fetch("/api/steer", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    })).then(async (response) => {
      if (response.status === 409) {
        setNotice(`${agentName} cannot take a message during its turn, so it is queued for when the turn is done.`);
        await enqueue();
      } else if (!response.ok) {
        setNotice("The message could not be sent.");
      }
    }, () => setNotice("The message could not be sent."));
  };

  // A file dropped anywhere on the view goes into the field (a drop the page let through would
  // open the file in its place). A chip dragged within the view is a link, not a drop to take.
  const attachRef = useRef<(files: File[], uris: string) => boolean>(() => false);
  useEffect(() => {
    const carries = (event: DragEvent) => {
      const types = [...(event.dataTransfer?.types ?? [])];
      return types.includes("Files") || types.includes("text/uri-list");
    };
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const over = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      clearTimeout(leaveTimer);
      setDropping(true);
    };
    const leave = () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => setDropping(false), 80); };
    const drop = (event: DragEvent) => {
      setDropping(false);
      if (!carries(event) || !event.dataTransfer) return;
      event.preventDefault();
      attachRef.current([...event.dataTransfer.files], event.dataTransfer.getData("text/uri-list"));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); clearTimeout(leaveTimer); };
  }, []);

  /** Files from a paste or a drop: read into the field, or named by path. */
  const attach = (files: File[], uris: string) => {
    const named = files.length === 0 ? attachmentsFromURIs(uris) : [];
    if (named.length) setAttachments((current) => [...current, ...named]);
    if (files.length === 0) return named.length > 0;
    void Promise.all(files.map(readAttachment)).then(
      (read) => setAttachments((current) => [...current, ...read]),
      () => setNotice("The file could not be read."),
    );
    input.current?.focus();
    return true;
  };
  attachRef.current = attach;

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

  const { row: options, more: moreOptions } = splitOptions(configOptions);
  const allowAll = useAllowAll(session);
  const showModes = modes && modes.availableModes.length > 1 && !configOptions.some((option) => option.category === "mode");
  const busy = prompting || working;

  return (
    <div className="dock" ref={dock}>
      <div className="inner">
        <OutdatedHost agentName={info.agent.name} typed={draft.trim() !== "" || attachments.length > 0} />
        <PlanLine />
        {slashItems.length > 0 && (
          <div className="pop slash" role="listbox" aria-label="Commands">
            {slashItems.map((item, index) => {
              const groupOf = (entry: SlashItem) => entry.kind === "command" ? (entry.command.view ? "This view" : agentName) : `/${slashCommand?.name}`;
              const group = groupOf(item);
              const previous = slashItems[index - 1];
              const previousGroup = previous && groupOf(previous);
              const key = item.kind === "choice" ? `c-${item.choice.value}` : item.kind === "conversation" ? `s-${item.conversation.sessionId}`
                : item.kind === "status" ? "status" : `${item.command.view ? "v" : "a"}-${item.command.name}`;
              if (item.kind === "status") {
                return (
                  <div key={key} style={{ display: "contents" }}>
                    {group !== previousGroup && <div className="gh">{group}</div>}
                    <div className="it status" aria-live="polite">{item.text}</div>
                  </div>
                );
              }
              return (
                <div key={key} style={{ display: "contents" }}>
                  {group !== previousGroup && <div className="gh">{group}</div>}
                  <div role="option" aria-selected={index === selectedSlash} className={`it${item.kind === "conversation" ? " conv" : ""}${index === selectedSlash ? " sel" : ""}`}
                    ref={index === selectedSlash ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
                    onMouseDown={(event) => { event.preventDefault(); pickSlash(item, true); }} onMouseEnter={() => setSelectedSlash(index)}>
                    {item.kind === "choice"
                      ? <><span>{item.choice.name}</span>{item.current && <small>current</small>}</>
                      : item.kind === "conversation"
                        ? <><span className="ct" title={item.conversation.title}>{item.conversation.title}</span>
                          <small>{[
                            item.conversation.current ? "open here" : item.conversation.openIn ? openInLabel(item.conversation.openIn) : null,
                            relativeTime(item.conversation.updatedAt),
                          ].filter(Boolean).join(" · ")}</small></>
                        : <><span className="p">/{item.command.name}</span>{(item.command.description || item.command.hint) && <small title={item.command.description}>{item.command.description || item.command.hint}</small>}</>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {slashHint && slashItems.length === 0 && (
          <div className="pop slash" aria-live="polite"><div className="it"><span className="p">/{slashCommand!.name} {slashHint}</span></div></div>
        )}
        {notice && <div className="note-line" role="status">{notice}</div>}
        {slashItems.length === 0 && mention && hits.length > 0 && (
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
        {queue.map((item) => editing?.id === item.id
          ? (
            <textarea key={item.id} className="qd editing" value={editing.text} autoFocus rows={Math.min(6, editing.text.split("\n").length)}
              aria-label="Edit the queued message"
              onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
              onBlur={() => setEditing(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const text = editing.text.trim();
                  setEditing(null);
                  if (text) void fetch(`/api/queue/${item.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
                }
              }} />
          )
          : (
            <div className={`qd ${item.state}`} key={item.id}>
              <span className="qt" title={item.state === "queued" ? "Edit" : undefined}
                onClick={() => { if (item.state === "queued") setEditing({ id: item.id, text: item.text }); }}>{item.text}</span>
              <small>{item.state === "offered" ? `waiting for ${agentName}'s next step` : "sent when the turn is done"}</small>
              <button type="button" className="qx" aria-label="Remove"
                onClick={() => void fetch(`/api/queue/${item.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).then((response) => {
                  if (response.status === 409) setNotice(`${agentName} has that message already.`);
                })}>
                <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
        {busy && !asking && (
          <div className="status">
            <span>{turnStart !== undefined ? `Working for ${duration(now - turnStart)}` : "Working"}</span>
            <span className="sp" />
            <span>{steerWay === "none"
              ? <><kbd>↵</kbd> queue · <kbd>esc</kbd> stop</>
              : <><kbd>↵</kbd> steer · <kbd>⌥↵</kbd> queue · <kbd>esc</kbd> stop</>}</span>
          </div>
        )}
        <form className={`box${dropping ? " dropping" : ""}`} onSubmit={(event) => { event.preventDefault(); submit("send"); }}>
          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((attachment) => (
                <span key={attachment.id} className={`att ${attachment.kind}`} title={attachment.path ?? attachment.name}>
                  {attachment.preview
                    ? <img src={attachment.preview} alt="" />
                    : <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4 1.8h4l2.5 2.5v7.9H4z M8 1.8v2.5h2.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>}
                  <span className="nm">{attachment.name}</span>
                  <button type="button" className="qx" aria-label={`Remove ${attachment.name}`}
                    onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}>
                    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            className="input"
            value={draft}
            rows={1}
            placeholder={busy ? (steerWay === "none" ? `Queue a message for when ${agentName} is done` : `Steer ${agentName} while it works`) : `Ask ${agentName}, @ for files and panes, / for commands`}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setMention(mentionAt(event.target.value, event.target.selectionStart ?? event.target.value.length));
              setSelectedHit(0);
              setSelectedSlash(0);
              setSlashClosed(false);
              setNotice(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              attach(files, "");
            }}
            onKeyDown={(event) => {
              if (slashItems.length > 0 && !event.nativeEvent.isComposing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSlash((index) => (index + (event.key === "ArrowDown" ? 1 : slashItems.length - 1)) % slashItems.length);
                  return;
                }
                const item = slashItems[Math.min(selectedSlash, slashItems.length - 1)];
                if (event.key === "Tab") { event.preventDefault(); pickSlash(item, false); return; }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); pickSlash(item, true); return; }
                if (event.key === "Escape") { event.preventDefault(); setSlashClosed(true); return; }
              }
              if (slashItems.length === 0 && mention && hits.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedHit((index) => (index + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(hits[selectedHit].path); return; }
                if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
              }
              if (event.key === "Backspace" && !draft && attachments.length > 0) {
                event.preventDefault();
                setAttachments((current) => current.slice(0, -1));
                return;
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
              <label className="opt" title={modesLabel(info.agent.id)}>
                <span className="lb">{modesLabel(info.agent.id)}</span>
                <span className="v">{modes!.availableModes.find((mode) => mode.id === modes!.currentModeId)?.name ?? modes!.currentModeId}</span> <Down />
                <select value={modes!.currentModeId} onChange={(event) => void session.setMode(event.target.value)} aria-label={modesLabel(info.agent.id)}>
                  {modes!.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
                </select>
              </label>
            )}
            {options.map((option) => (
              <label className={`opt${option.category === "model" ? " model" : ""}`} key={option.id} title={`${settingTitle(option, info.agent.id)}: ${currentName(option)}`}>
                <span className="lb">{settingLabel(option, info.agent.id)}</span> <span className="v">{currentName(option)}</span> <Down />
                <select value={String(option.currentValue)} aria-label={settingLabel(option, info.agent.id)}
                  onChange={(event) => void session.setConfigOption(option.id, event.target.value)}>
                  {choicesOf(option).map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
                </select>
              </label>
            ))}
            {allowAll.offered && (
              <button className={`opt level allow fold${allowAll.on ? " on" : ""}`} type="button" aria-pressed={allowAll.on}
                aria-label={`Approvals: ${allowAll.on ? "Allow all" : "Ask"}`} title={allowAllTitle(allowAll.on)}
                onClick={() => void allowAll.set(!allowAll.on)}>
                <ApprovalsIcon on={allowAll.on} />
                <span className="lb">Approvals</span> <span className="v">{allowAll.on ? "Allow all" : "Ask"}</span>
              </button>
            )}
            <button className="opt level fold" type="button" aria-label={`Detail: ${DETAIL_TITLES[level]}`} title={`How much of the work shows: ${DETAIL_TITLES[level]} (⌃O)`} onClick={onCycleLevel}>
              <LevelIcon level={level} />
              <span className="v">{DETAIL_TITLES[level]}</span>
            </button>
            <MoreOptions options={moreOptions} session={session} agentId={info.agent.id}>
              {/* What the row folds in when the field is too narrow for it (view.css). */}
              {allowAll.offered && (
                <button className="it folded" type="button" aria-pressed={allowAll.on} title={allowAllTitle(allowAll.on)} onClick={() => void allowAll.set(!allowAll.on)}>
                  <span>Approvals</span><span className={`mv${allowAll.on ? " on" : ""}`}>{allowAll.on ? "Allow all" : "Ask"}</span>
                </button>
              )}
              <button className="it folded" type="button" title="How much of the work shows (⌃O)" onClick={onCycleLevel}>
                <span>Detail</span><span className="mv"><LevelIcon level={level} /> {DETAIL_TITLES[level]}</span>
              </button>
            </MoreOptions>
            <span className="sp" />
            {dictation.available && (
              <button className={`icon mic${dictation.state === "recording" ? " rec" : ""}${dictation.error ? " err" : ""}`} type="button"
                aria-label={dictation.state === "recording" ? "Stop dictating" : "Dictate"}
                title={dictation.error ?? (dictation.state === "recording" ? "Stop, and write it into the field (⇧⌘M)" : dictation.state === "transcribing" ? "Writing it down…" : "Dictate (⇧⌘M)")}
                disabled={dictation.state === "transcribing"}
                onClick={dictation.toggle}>
                {dictation.state === "transcribing"
                  ? <span className="mic-wait" aria-hidden="true" />
                  : <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="5" y="1.6" width="4" height="7" rx="2" fill={dictation.state === "recording" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" /><path d="M3 6.8a4 4 0 0 0 8 0M7 10.8v1.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}
              </button>
            )}
            {usage && <Usage usage={usage} />}
            {busy && !draft.trim()
              ? <button className="go stop" type="button" aria-label="Stop" onClick={() => void session.cancel()}>
                  <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.3" fill="currentColor" /></svg>
                </button>
              : <SendButton ready={Boolean(draft.trim())} flying={flying} label={busy ? (steerWay === "none" ? "Queue" : "Steer") : "Send"} />}
          </div>
        </form>
      </div>
    </div>
  );
}

/** The agent's other settings, under ⋯: each with what it sets and its choice. */
function MoreOptions({ options, session, agentId, children }: {
  options: SessionConfigOption[]; session: AcpSession; agentId: string; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return (
    // With no settings of its own it shows only when the row folds into it.
    <div className={`more${options.length === 0 ? " fold-only" : ""}`} ref={box}>
      <button className={`opt level${open ? " open" : ""}`} type="button" aria-label="More settings" aria-expanded={open}
        title={options.map((option) => `${settingLabel(option, agentId)}: ${currentName(option)}`).join("\n")}
        onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="2.5" cy="6" r="1.1" fill="currentColor" /><circle cx="6" cy="6" r="1.1" fill="currentColor" /><circle cx="9.5" cy="6" r="1.1" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className="pop more-pop" role="group" aria-label="More settings">
          {options.map((option) => (
            <label className="it" key={option.id} title={settingTitle(option, agentId)}>
              <span>{settingLabel(option, agentId)}</span>
              <span className="mv">{currentName(option)} <Down /></span>
              <select value={String(option.currentValue)} aria-label={settingLabel(option, agentId)}
                onChange={(event) => void session.setConfigOption(option.id, event.target.value)}>
                {choicesOf(option).map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
              </select>
            </label>
          ))}
          {children}
        </div>
      )}
    </div>
  );
}

function allowAllTitle(on: boolean): string {
  return on
    ? "Approvals: Allow all. Tool calls run without asking, as the agent's command says. Click to be asked again."
    : "Approvals: Ask. The agent asks before each tool call. Click to allow them all, as -a does in the terminal.";
}

/** A shield, with a check while every tool call is allowed. */
function ApprovalsIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.2 2.2 2.6v3c0 2.4 1.6 4.2 3.8 5.2 2.2-1 3.8-2.8 3.8-5.2v-3z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      {on && <path d="M4.2 6.1 5.5 7.4 7.9 4.8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function LevelIcon({ level }: { level: DetailLevel }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true"><path d={level === "results" ? "M2 6h8" : level === "steps" ? "M2 4h8M2 8h5" : "M2 3h8M2 6h8M2 9h8"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
  );
}

/** Whether the host allows each tool call itself (Kiro's -a, OpenCode's --auto), and the switch. */
function useAllowAll(session: AcpSession): AllowAll & { set: (on: boolean) => Promise<void> } {
  const [state, setState] = useState<AllowAll>({ offered: false, on: false });
  useEffect(() => {
    let current = true;
    session.onAllowAll((next) => { if (current) setState(next); });
    void session.allowAll().then((next) => { if (current) setState(next); });
    return () => { current = false; };
  }, [session]);
  return {
    ...state,
    set: async (on) => {
      setState((previous) => ({ ...previous, on }));
      try {
        setState(await session.setAllowAll(on));
      } catch {
        setState((previous) => ({ ...previous, on: !on }));
      }
    },
  };
}

/** Send, in ink: grey until there is something to send; the arrow flies off when it sends. */
function SendButton({ ready, flying, label }: { ready: boolean; flying: boolean; label: string }) {
  return (
    <button className={`go${ready ? "" : " off"}${flying ? " fly" : ""}`} type="submit" aria-label={label} disabled={!ready && !flying}>
      <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

/** The agent's todo list above the field: the step under way and how many are done, which opens to
 *  every step with its mark. */
/** A host that runs an older agents CLI than this view (the CLI was updated while the agent ran):
 *  Codex's host starts again by itself while nothing goes on, the agent untouched; another agent
 *  offers to start again on its session, under the current host. */
function OutdatedHost({ agentName, typed }: { agentName: string; typed: boolean }) {
  // Asking or working: a restart now would cut the turn short.
  const busy = useSession((s) => s.prompting || attention(s) !== "idle");
  const [host, setHost] = useState<{ build: string; mode?: string } | null>(null);
  const view = viewBuild();
  useEffect(() => {
    if (!view) return;
    hostJson<{ agentsCLI?: string; mode?: string }>("/api/diagnostics").then((report) => {
      if (hostOutdated(view, report.agentsCLI)) setHost({ build: report.agentsCLI!, mode: report.mode });
    }, () => {});
  }, [view]);
  const tried = host ? readTried(host.build) : false;
  const action = host ? outdatedHostAction({ mode: host.mode, inApp: inMacApp(), idle: !busy && !typed, tried }) : null;
  useEffect(() => {
    if (action !== "restart-host" || !host) return;
    writeTried(host.build);
    window.location.href = APP_ACTIONS.restartViewHost;
  }, [action, host]);
  if (!host || !action || action === "restart-host") return null;
  const title = `The view host runs agents CLI ${host.build}; this view is ${view}.`;
  return (
    <div className="outdated-host" role="status" title={title}>
      <span className="oh-text">
        {action === "offer-host-restart" && "This view's host runs an earlier agents CLI."}
        {action === "offer-agent-restart" && `${agentName}'s view host runs an earlier agents CLI.`}
        {action === "say" && `${agentName}'s view host runs an earlier agents CLI: start ${agentName} again from Agents Next to update it.`}
      </span>
      {action === "offer-host-restart" && (
        <button type="button" className="link" disabled={busy} title={busy ? `When ${agentName} is idle` : "Restart the view host; the agent keeps running"}
          onClick={() => { writeTried(host.build); window.location.href = APP_ACTIONS.restartViewHost; }}>Update</button>
      )}
      {action === "offer-agent-restart" && (
        <button type="button" className="link" disabled={busy} title={busy ? `When ${agentName} is idle` : `Restart ${agentName} on this session`}
          onClick={() => { window.location.href = APP_ACTIONS.restartInACPMode; }}>Restart {agentName} to update</button>
      )}
    </div>
  );
}

function readTried(build: string): boolean {
  try { return sessionStorage.getItem(triedKey(build)) === "1"; } catch { return false; }
}

function writeTried(build: string): void {
  try { sessionStorage.setItem(triedKey(build), "1"); } catch { /* no storage */ }
}

function PlanLine() {
  const plan = useSession((s) => s.plan);
  const working = useSession((s) => attention(s) !== "idle");
  const [open, setOpen] = useState(storedPlanOpen);
  const summary = planSummary(plan);
  if (!planShown(summary, working)) return null;
  const toggle = () => setOpen((value) => { storePlanOpen(!value); return !value; });
  const { current, done, total } = summary;
  return (
    <div className={`plan-line${open ? " open" : ""}`} aria-label="Plan">
      <button type="button" className="pl-head" onClick={toggle} aria-expanded={open} title={open ? "Hide the plan" : "Show the plan"}>
        {open ? <span className="pl-now">Plan</span> : <>
          <PlanMark status={current?.status ?? "completed"} working={working} />
          <span className="pl-now">{current?.content ?? "All done"}</span>
        </>}
        <span className="pl-count">{done}/{total}</span>
        <Chevron />
      </button>
      {open && (
        <ol className="pl-list">
          {plan.map((entry, index) => (
            <li key={index} className={`pl-item ${entry.status}`}>
              <PlanMark status={entry.status} working={working} />
              <span className="pl-text">{entry.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PlanMark({ status, working }: { status: PlanEntry["status"]; working: boolean }) {
  if (status === "completed") {
    return <svg className="pl-mark done" viewBox="0 0 12 12" aria-label="Done"><path d="M2.2 6.4l2.5 2.5 5.1-5.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (status === "in_progress") return <span className={`pl-mark now${working ? " spin" : ""}`} aria-label="Under way" />;
  return <span className="pl-mark todo" aria-label="To do" />;
}

function Conversation({ session, info }: { session: AcpSession; info: HostInfo }) {
  const items = useSession((s) => s.items);
  const toolCalls = useSession((s) => s.toolCalls);
  const title = useSession((s) => s.title);
  const permissions = useSession((s) => s.permissions);
  const state = useSession((s) => attention(s));
  // A turn that waits on a question is still under way.
  const working = state === "working" || state === "needs-you";
  const builtTurns = useMemo(() => buildTurns({ items, toolCalls }), [items, toolCalls]);
  const gitTurns = useGitTurns(working, builtTurns.length);
  const turns = useMemo(() => builtTurns.map((turn, index) => {
    const git = gitTurns[index];
    return git ? { ...turn, changes: mergeChanges(turn.changes, git.files, { from: git.from, to: git.to }) } : turn;
  }), [builtTurns, gitTurns]);
  const now = useNow(working);
  const [review, setReview] = useState<FileChange[] | null>(null);
  const myReviews = useRef(new Set<string>());
  // The conversation comes in with a motion only where it can be seen: a page that opens hidden (a
  // window behind others or a locked screen) keeps its animations at their first frame, and the
  // conversation stays invisible in any picture of the pane until the window is shown.
  const [arrives] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");

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
    // A line the agents CLI typed into the pane's terminal (a wake-up for a Codex coordinator):
    // the turn it starts shows its text, which Codex does not pass on.
    events.addEventListener("typed", (event) => {
      const { text } = JSON.parse((event as MessageEvent<string>).data) as { text: string };
      dispatch({ type: "typedInTerminal", text, at: Date.now() });
    });
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
  const openReview = async (given: FileChange[]) => {
    // Files only git saw: their text before and after comes from the turn's snapshots.
    const changes = await Promise.all(given.map(async (change) => {
      if (change.edits.length > 0 || !change.snapshot) return change;
      const versions = await hostJson<{ oldText: string | null; newText: string }>(
        `/api/git/versions?from=${change.snapshot.from}&to=${change.snapshot.to}&path=${encodeURIComponent(change.path)}`,
      ).catch(() => null);
      return versions ? { ...change, edits: [versions] } : change;
    }));
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
  const [level, setLevel] = useState<DetailLevel>(storedDetailLevel);
  const cycleLevel = useCallback(() => setLevel((current) => { const next = nextDetailLevel(current); storeDetailLevel(next); return next; }), []);
  // ⌃O cycles how much of the work shows, wherever the keyboard is in the view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "o") { event.preventDefault(); cycleLevel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleLevel]);
  const detail = useMemo(() => ({
    level,
    // A command's output opens in a pane beside, as a page of the host's.
    openOutput: (title: string, text: string) => {
      void hostJson("/api/output", { title, text }).catch(() => {});
    },
  }), [level]);
  const openReviewRef = useRef(openReview);
  openReviewRef.current = openReview;
  // /changes: one review of every file the conversation changed.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  useEffect(() => {
    const onReview = (event: Event) => {
      const changes = conversationChanges(turnsRef.current);
      (event as CustomEvent<{ answer?: (count: number) => void }>).detail?.answer?.(changes.length);
      if (changes.length > 0) void openReviewRef.current(changes);
    };
    window.addEventListener(PAGE_EVENTS.reviewConversation, onReview);
    return () => window.removeEventListener(PAGE_EVENTS.reviewConversation, onReview);
  }, []);
  const chipHost = useMemo<ChipHost>(() => ({
    cwd: info.cwd,
    inApp: OPEN_REVIEW_BESIDE,
    hostJson,
    rawURL: (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token ?? "")}`,
    open: (target, options) => openChip(target, options, (changes) => void openReviewRef.current(changes)),
  }), [info.cwd]);
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
    <ChipHostContext.Provider value={chipHost}>
    <DetailContext.Provider value={detail}>
    <PeekLayer>
    <div className={`view${review ? " reviewing" : ""}`} data-acp-ready="true" data-attention={state}>
      <div className="main" ref={main}>
        <div className="scroll-wrap">
        <ScrollThumb target={scroller} />
        <div className="scroll under-dock" ref={scroller} onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}>
          <div className={arrives ? "col arrive" : "col"}>
            <WorkerLine />
            {turns.length === 0 && <div className="empty">Nothing in the session yet. Write to {info.agent.name} below.</div>}
            {turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} last={index === turns.length - 1} working={working} cwd={info.cwd}
                onReview={(t) => void openReview(t.changes)}
                onSend={(text) => void (working ? session.steer : session.prompt)([{ type: "text", text }])} />
            ))}
            {working && permissions.length === 0 && <CurrentStep turn={lastTurn} now={now} cwd={info.cwd} />}
            {permissions.map((request, index) => (
              <Ask key={request.id} request={request} agentName={info.agent.name} session={session} focused={index === 0} cwd={info.cwd} />
            ))}
          </div>
        </div>
        </div>
        <Dock session={session} info={info} now={now} onHeight={onDockHeight} level={level} onCycleLevel={cycleLevel} />
      </div>
      {review && (
        <ReviewPane changes={review} cwd={info.cwd} agentName={info.agent.name}
          onClose={() => setReview(null)}
          onSend={(text) => { setReview(null); void (working ? session.steer : session.prompt)([{ type: "text", text }]); }} />
      )}
    </div>
    </PeekLayer>
    </DetailContext.Provider>
    </ChipHostContext.Provider>
  );
}

/** Each turn's changes as git sees them: a snapshot of the working tree when the agent starts
 *  working, compared with the tree when it stops (the host writes both with a temporary index).
 *  Keyed by the turn's place in the conversation. Outside a git repository there are none. */
function useGitTurns(working: boolean, turnCount: number): Record<number, { from: string; to: string; files: GitChange[] }> {
  const [byTurn, setByTurn] = useState<Record<number, { from: string; to: string; files: GitChange[] }>>({});
  const start = useRef<Promise<string | null> | null>(null);
  const count = useRef(turnCount);
  count.current = turnCount;
  useEffect(() => {
    if (!token) return;
    if (working && !start.current) {
      start.current = hostJson<{ tree: string | null }>("/api/git/snapshot", {}).then((value) => value.tree, () => null);
    } else if (!working && start.current) {
      const pending = start.current;
      start.current = null;
      void pending.then(async (from) => {
        if (!from) return;
        const changes = await hostJson<{ tree: string; files: Array<GitChange & { binary: boolean }> }>(`/api/git/changes?tree=${from}`).catch(() => null);
        if (!changes) return;
        // The turn that just ended is the last one now.
        const index = count.current - 1;
        setByTurn((current) => ({ ...current, [index]: { from, to: changes.tree, files: changes.files } }));
      });
    }
  }, [working]);
  return byTurn;
}

/** What a click on a chip does. In Agents Next: a file opens beside the pane (⌥ in the editor),
 *  a changed file opens this turn's diff beside it, a pane shows, an image opens in Quick Look, a
 *  link, a bead or a commit opens in a pane beside (a link with ⌥ in the default browser). */
function openChip(target: ChipTarget, options: { alternate: boolean; command?: boolean; change?: FileChange }, openReview: (changes: FileChange[]) => void) {
  // A plain click opens a link, as on a web page; ⌘ opens a file in the editor and a web page in
  // the default browser (in a terminal, where a click places the cursor, ⌘ is what opens).
  if (options.command) {
    if (target.kind === "url" || target.kind === "ticket") { window.open(target.url, "_blank"); return; }
    if (target.kind === "file" || target.kind === "dir" || target.kind === "image") {
      postToApp(APP_HANDLERS.link, { href: `${target.path}${"line" in target && target.line ? `:${target.line}` : ""}`, alternate: true });
      return;
    }
  }
  switch (target.kind) {
    case "file":
    case "dir":
      if (options.change && !options.alternate) { openReview([options.change]); return; }
      postToApp(APP_HANDLERS.link, { href: `${target.path}${target.line ? `:${target.line}` : ""}`, alternate: options.alternate });
      return;
    case "image":
      if (!postToApp(APP_HANDLERS.quickLook, { path: target.path })) window.open(`/api/raw?path=${encodeURIComponent(target.path)}&token=${encodeURIComponent(token ?? "")}`, "_blank");
      return;
    case "pane":
      postToApp(APP_HANDLERS.link, { href: target.id });
      return;
    case "url":
    case "ticket":
      if (options.alternate || !OPEN_REVIEW_BESIDE) { window.open(target.url, "_blank"); return; }
      hostJson("/api/open-page", { url: target.url }).catch(() => window.open(target.url, "_blank"));
      return;
    case "bead":
      if (!OPEN_REVIEW_BESIDE) { window.open(`/bead/${encodeURIComponent(target.id)}#token=${encodeURIComponent(token ?? "")}`, "_blank"); return; }
      void hostJson("/api/open-page", { url: `/bead/${encodeURIComponent(target.id)}` }).catch(() => {});
      return;
    case "commit":
      void hostJson<{ changes: FileChange[] }>(`/api/commit/${target.sha}/changes`).then((value) => openReview(value.changes), () => {});
      return;
  }
}

/** The session the address names, or for /thread/current the one the pane's agent has open now:
 *  Codex's thread is known from the pane's app-server before its first prompt, though no hook has
 *  reported it yet. */
function SessionGate({ info }: { info: HostInfo }) {
  const [gate, setGate] = useState<GatePhase>(() => initialGate(sessionId));
  useEffect(() => {
    if (gate.kind !== "finding") return;
    // An agent just started opens its session a moment after its host is up.
    // An agent held up as it starts (a question in its terminal, TerminalWait) has none for as
    // long as it is held up: the view goes on waiting, and opens the session once it has one.
    // Only a host that does not answer at all ends the wait.
    const current = async () => {
      const started = Date.now();
      for (let failures = 0; ;) {
        try {
          return await hostJson<{ sessionId: string | null; persisted?: boolean; busy?: boolean }>("/api/session");
        } catch (error) {
          if (error instanceof HostAnswer && error.status === 404) failures = 0;
          else if ((failures += 1) >= 300) throw error;
          // Asked often at first: the view opens the moment the host has the session.
          await new Promise((resolve) => setTimeout(resolve, Date.now() - started < 30_000 ? 100 : 1_000));
        }
      }
    };
    current().then(
      (value) => {
        setGate(gateFromHost(value));
        // A reload opens the same thread, whatever the pane has open then.
        if (value.sessionId !== null) history.replaceState(null, "", `/thread/${encodeURIComponent(value.sessionId)}${location.search}${location.hash}`);
      },
      (error: unknown) => setGate({ kind: "no-session", problem: error instanceof Error ? error.message : String(error) }),
    );
  }, []);
  // codex-acp does not follow a turn that is already running when it loads the thread.
  useEffect(() => {
    if (gate.kind !== "waiting-for-idle") return;
    let stopped = false;
    const waiting = gate.sessionId;
    void untilIdle(waiting, () => stopped).then(() => { if (!stopped) setGate({ kind: "open", sessionId: waiting }); });
    return () => { stopped = true; };
  }, [gate]);
  switch (gate.kind) {
    case "finding": return <><Opening text={openingText(info.agent.name)} /><TerminalWait agentName={info.agent.name} showsTail /></>;
    case "starts-new": return <SessionView info={info} sessionId={null} />;
    case "no-session": return <Notice>The pane has no {info.agent.name} session yet{gate.problem ? ` (${gate.problem})` : ""}.</Notice>;
    case "waiting-for-idle": return <Opening text={`${info.agent.name} is working; the session shows when it is done`} />;
    case "first-prompt": return <FirstPrompt info={info} sessionId={gate.sessionId} onStarted={() => setGate({ kind: "open", sessionId: gate.sessionId })} />;
    case "open": return <SessionView info={info} sessionId={gate.sessionId} />;
  }
}

interface TerminalScreen {
  prompt: { text: string[]; options: Array<{ index: number; label: string; selected: boolean }>; hint: string[] } | null;
  tail: string[];
}

/** How long the view waits for a session before it shows what the agent's terminal shows. */
const TERMINAL_TAIL_AFTER_MS = 6_000;
/** How long an open conversation watches its agent's terminal for a question it starts with. */
const TERMINAL_PROMPT_WATCH_MS = 120_000;

/**
 * What the pane's agent shows in its terminal while the view waits for its session (the host's
 * terminal-prompt.ts): a question it waits on as it starts (Codex's hooks review, a folder to
 * trust), with its answers as buttons, or with `showsTail`, after a while without a session, the
 * lines its terminal shows (an error it stopped on). Without either the opening frame stays as it is.
 */
function TerminalWait({ agentName, showsTail = false, forMs }: { agentName: string; showsTail?: boolean; forMs?: number }) {
  const [screen, setScreen] = useState<TerminalScreen | null>(null);
  const [late, setLate] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const promptShown = useRef(false);
  useEffect(() => {
    let stopped = false;
    const started = Date.now();
    const timer = setTimeout(() => setLate(true), TERMINAL_TAIL_AFTER_MS);
    const poll = async () => {
      while (!stopped) {
        // Past its watch, a question still shown stays until it is answered.
        if (forMs !== undefined && Date.now() - started > forMs && !promptShown.current) { setScreen(null); return; }
        const next = await hostJson<TerminalScreen>("/api/terminal-prompt").catch(() => null);
        if (!stopped && next) { setScreen(next); promptShown.current = Boolean(next.prompt); }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const prompt = screen?.prompt;
  const tail = showsTail && late && !prompt && screen?.tail.length ? screen.tail : null;
  if (!prompt && !tail) return null;
  const answer = async (option: { index: number; label: string }) => {
    setAnswering(true);
    setProblem(null);
    try {
      const answered = await hostJson<{ screen: TerminalScreen }>("/api/terminal-prompt", option);
      setScreen(answered.screen);
    } catch (error) {
      setProblem(error instanceof HostAnswer && error.hostMessage ? error.hostMessage : `The answer did not reach ${agentName}.`);
    } finally {
      setAnswering(false);
    }
  };
  const terminal = inMacApp()
    ? <button type="button" className="link" onClick={() => { window.location.href = APP_ACTIONS.backToTerminal; }}>Show terminal</button>
    : null;
  return (
    <div className="terminal-wait" role="dialog" aria-label={`${agentName} asks in its terminal`}>
      {prompt ? (
        <>
          <div className="terminal-wait-title">{agentName} is waiting for an answer in its terminal</div>
          {prompt.text.length > 0 && <pre className="terminal-wait-text">{prompt.text.join("\n")}</pre>}
          <div className="terminal-wait-options">
            {prompt.options.map((option) => (
              <button key={option.index} type="button" disabled={answering} className={option.selected ? "selected" : undefined}
                onClick={() => void answer(option)}>
                {option.index}. {option.label}
              </button>
            ))}
          </div>
          {problem && <div className="terminal-wait-problem">{problem}</div>}
          <div className="terminal-wait-foot">{forMs === undefined ? `The session opens here once ${agentName} goes on.` : `${agentName} goes on once it is answered.`} {terminal}</div>
        </>
      ) : (
        <>
          <div className="terminal-wait-title">{agentName} has not opened its session yet</div>
          <div className="terminal-wait-foot">Its terminal shows:</div>
          <pre className="terminal-wait-text">{tail!.join("\n")}</pre>
          <div className="terminal-wait-foot">The view goes on waiting. {terminal}</div>
        </>
      )}
    </div>
  );
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
  const [phase, send] = useReducer(nextViewPhase, { kind: "connecting" } as ViewPhase);
  // A new connection for a retry, or for "Take over here", which asks the host for the session
  // another view has.
  const [reconnects, setReconnects] = useState(0);
  const [takeOvers, setTakeOvers] = useState(0);
  const takeOverHere = () => setTakeOvers((count) => count + 1);
  const opening = useOpeningConversation((s) => s.text);
  const session = useMemo(() => token
    ? connectSession({
      url: `ws://${location.host}/acp?token=${encodeURIComponent(token)}`,
      sessionId, cwd: info.cwd, agentId: info.agent.id, dispatch, takeOver: takeOvers > 0,
      onTakenOver: () => send({ type: "taken-over" }),
    })
    : null, [info.cwd, info.agent.id, dispatch, takeOvers, reconnects]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    send({ type: "connect" });
    Promise.all([session.load(), markdownReady.catch(() => undefined)])
      .then(([loadedSession]) => {
        if (cancelled) return;
        // A reload opens the session the view started.
        if (!sessionId) history.replaceState(null, "", `/thread/${encodeURIComponent(loadedSession.sessionId)}${location.search}${location.hash}`);
        mark("loaded");
        send({ type: "loaded" });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof CannotLoadSession) { send({ type: "cannot-load", version: reason.agentInfo?.version }); return; }
        if (reason instanceof OpenElsewhere) { session.close(); send({ type: "open-elsewhere" }); return; }
        send({ type: "failed", failure: { title: "The session could not be opened", detail: errorDetail(reason) } });
      });
    session.closed.then(
      () => { if (!cancelled) send({ type: "failed", failure: { title: `The connection to ${info.agent.name} closed`, detail: { message: "The host ended the connection or the agent exited." } } }); },
      (reason: unknown) => { if (!cancelled) send({ type: "failed", failure: { title: `The connection to ${info.agent.name} broke`, detail: errorDetail(reason) } }); },
    );
    return () => { cancelled = true; };
  }, [session, info.agent.name]);

  // Another conversation is opening in the pane: its connection ends as the pane's agent starts
  // again, which is no error to show.
  if (opening) return <Opening text={opening} />;
  switch (phase.kind) {
    case "cannot-load": {
      // Copilot's changelog has ACP sessions resumed from 1.0.95 (0.0.406 cannot load one).
      const minimum = info.agent.id === "github-copilot-cli" ? "1.0.95 or later" : "a version that can";
      return (
        <Notice>
          <div>
            This {info.agent.name}{phase.version ? ` (${phase.version})` : ""} can't open its session in the web view: it cannot load an existing session (ACP <code>session/load</code>).
            <br />Update {info.agent.name} to {minimum}, or go on in the terminal.
          </div>
        </Notice>
      );
    }
    case "taken-over":
      return (
        <Notice>
          <div>The session was taken over by another view. <button type="button" className="link" onClick={takeOverHere}>Take it back here</button></div>
        </Notice>
      );
    case "open-elsewhere":
      return (
        <Notice>
          <div>The session is already open in another view. <button type="button" className="link" onClick={takeOverHere}>Take over here</button></div>
        </Notice>
      );
    case "failed":
      return <ErrorNotice title={phase.failure.title} error={phase.failure.detail} agentName={info.agent.name}
        onRetry={() => setReconnects((count) => count + 1)} />;
    case "connecting":
      return <><Opening text={openingText(info.agent.name)} /><TerminalWait agentName={info.agent.name} /></>;
    case "open":
      if (!session) return <><Opening text={openingText(info.agent.name)} /><TerminalWait agentName={info.agent.name} /></>;
      // An agent that shares its session live (Codex) runs its TUI beside the view: one held up by a
      // question as it starts says so over its conversation, for a while after the view opens.
      return <><Conversation session={session} info={info} /><TerminalWait agentName={info.agent.name} forMs={TERMINAL_PROMPT_WATCH_MS} /></>;
  }
}

/** A review opened as a pane of its own (/review/<id>): its comments go back to the view that
 *  opened it, through the host. */
function ReviewPage({ id }: { id: string }) {
  // `readOnly`: changes no agent made (`agents review`, for Agents Next's Changes), to read only.
  type Review = { changes: FileChange[]; cwd: string; agentName: string; focus?: string; message?: string; readOnly?: boolean };
  const [review, setReview] = useState<Review | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "sent" | "missing">("loading");
  useEffect(() => {
    hostJson<Review>(`/api/review/${encodeURIComponent(id)}`)
      .then((value) => {
        setReview(value);
        setState("ready");
        document.title = value.readOnly ? (value.focus ?? value.changes[0]?.path ?? "Changes").split("/").pop()! : `Changes – ${value.agentName}`;
      })
      .catch(() => setState("missing"));
  }, [id]);
  if (state === "missing") return <Notice>The review is gone. Open it again from the agent's view or Changes.</Notice>;
  if (!review) return <Notice>Opening the review…</Notice>;
  if (state === "sent") return <Notice>The comments were sent to {review.agentName}. The pane can be closed.</Notice>;
  return (
    <div className="view review-page">
      <ReviewPane changes={review.changes} cwd={review.cwd} agentName={review.agentName} focus={review.focus} message={review.message}
        onSend={review.readOnly ? undefined : (text) => {
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
const beadId = decodeURIComponent(location.pathname.match(/^\/bead\/([^/]+)/)?.[1] ?? "") || null;
const outputId = decodeURIComponent(location.pathname.match(/^\/output\/([^/]+)/)?.[1] ?? "") || null;

/** A command's output, opened beside its pane (/output/<id>). */
function OutputPage({ id }: { id: string }) {
  const [output, setOutput] = useState<{ title: string; text: string } | null | undefined>(undefined);
  useEffect(() => {
    hostJson<{ title: string; text: string }>(`/api/output/${encodeURIComponent(id)}`).then((value) => { setOutput(value); document.title = value.title; }, () => setOutput(null));
  }, [id]);
  if (output === undefined) return <Notice>Opening the output…</Notice>;
  if (output === null) return <Notice>The output is gone. Open it again from the agent's view.</Notice>;
  return (
    <div className="view output-page"><div className="main"><div className="scroll"><div className="col">
      <div className="bead-head"><span className="mono">{output.title}</span></div>
      <pre className="full-output">{output.text}</pre>
    </div></div></div></div>
  );
}

interface BeadDetail { id: string; title: string; status: string; priority?: number; type?: string; description?: string; notes?: string; updated?: string }

/** A bead the agent named, opened as a page beside its pane (/bead/<id>). */
function BeadPage({ id }: { id: string }) {
  const [bead, setBead] = useState<BeadDetail | null | undefined>(undefined);
  useEffect(() => {
    hostJson<BeadDetail>(`/api/bead/${encodeURIComponent(id)}`).then((value) => { setBead(value); document.title = `${value.id} – ${value.title}`; }, () => setBead(null));
  }, [id]);
  if (bead === undefined) return <Notice>Opening {id}…</Notice>;
  if (bead === null) return <Notice>There is no bead {id} in this project.</Notice>;
  const meta = [bead.type, bead.status.replace(/_/g, " "), bead.priority !== undefined ? `P${bead.priority}` : null, bead.updated ? `updated ${new Date(bead.updated).toLocaleString()}` : null].filter(Boolean).join(" · ");
  return (
    <div className="view bead-page"><div className="main"><div className="scroll"><div className="col">
      <div className="bead-head"><span className="mono">{bead.id}</span><span className="dim">{meta}</span></div>
      <h1>{bead.title}</h1>
      {bead.description && <div className="say"><Suspense fallback={<p className="plain">{bead.description}</p>}><Markdown text={bead.description} streaming={false} /></Suspense></div>}
      {bead.notes && (<><h2>Notes</h2><div className="say"><Suspense fallback={<p className="plain">{bead.notes}</p>}><Markdown text={bead.notes} streaming={false} /></Suspense></div></>)}
    </div></div></div></div>
  );
}

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
  if (beadId) return <BeadPage id={beadId} />;
  if (outputId) return <OutputPage id={outputId} />;
  if (error) return <Notice>The pane's ACP host does not answer: {error}</Notice>;
  if (!info) return <Opening />;
  return <SessionGate info={info} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
