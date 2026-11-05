// The ACP view of one agent pane, for any agent. The page address names the session
// (/thread/<id>) and carries the pane's token in its fragment (#token=...); the page asks the
// host which agent it serves, connects to the adapter the host starts for this client, loads
// that session and shows it. No agent or session picker and no header: the pane decides what is
// shown, and the app's pane header names the agent.
//
// The look: a reading column, the agent's text straight on the page, its work as quiet gray lines
// that open on demand, one floating field to write in.
import { StrictMode, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { connectSession, type AcpSession } from "./acp-connection";
import { attention, emptySession, reduce, type PermissionRequest, type SessionAction, type SessionState, type ToolCall } from "./session-state";
import { buildTurns, changesOf, describeCall, duration, shortPath, toolOutput, type FileChange, type Step, type Turn } from "./turns";
import { ReviewPane } from "./review";
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
const applyTheme = () => {
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

function Notice({ children }: { children: ReactNode }) {
  return <div className="notice">{children}</div>;
}

const PRESENT: Record<string, string> = {
  "Läste": "Läser", "Ändrade": "Ändrar", "Sökte": "Söker", "Körde": "Kör", "Hämtade": "Hämtar",
  "Tänkte": "Tänker", "Tog bort": "Tar bort", "Flyttade": "Flyttar", "Bytte läge": "Byter läge",
};

function ToolLine({ call, cwd }: { call: ToolCall; cwd: string }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = describeCall(call, cwd);
  const output = toolOutput(call);
  const diffCount = call.content.some((entry) => entry.type === "diff");
  let meta: ReactNode = null;
  if (call.status === "failed") meta = <span className="del">misslyckades</span>;
  else if (diffCount) {
    let added = 0;
    let removed = 0;
    for (const change of changesForCall(call)) { added += change.added; removed += change.removed; }
    meta = <><span className="add">+{added}</span> <span className="del">−{removed}</span></>;
  } else if (call.startedAt !== undefined && call.endedAt !== undefined && call.kind === "execute") {
    meta = duration(call.endedAt - call.startedAt).replace(/^0 s$/, "< 1 s");
  }
  const canOpen = Boolean(output);
  return (
    <>
      <div className={`ln${canOpen ? " can-open" : ""}`} onClick={() => canOpen && setOpen(!open)} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined}
        onKeyDown={(event) => { if (canOpen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(!open); } }}>
        {verb && <span className="v">{verb}</span>}
        <span className="t">{target}</span>
        {meta !== null && <span className="m">{meta}</span>}
      </div>
      {open && output && <pre className="out">{output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output}</pre>}
    </>
  );
}

function changesForCall(call: ToolCall): FileChange[] {
  return changesOf([call]);
}

function StepLine({ step, cwd }: { step: Step; cwd: string }) {
  if (step.type === "thought") return <div className="think">{step.text}</div>;
  if (step.type === "remark") return <div className="remark">{step.text}</div>;
  return <ToolLine call={step.call} cwd={cwd} />;
}

function Activity({ turn, working, cwd }: { turn: Turn; working: boolean; cwd: string }) {
  const [open, setOpen] = useState(false);
  if (turn.steps.length === 0) return null;
  const isOpen = working || open;
  const label = working
    ? "Arbetar"
    : turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt - turn.startedAt >= 1000
      ? `Arbetade i ${duration(turn.endedAt - turn.startedAt)}`
      : `Arbetade, ${turn.steps.length} ${turn.steps.length === 1 ? "steg" : "steg"}`;
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
      <span>{changes.length === 1 ? `1 fil ändrad` : `${changes.length} filer ändrade`}</span>
      <span className="n"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      <span className="files">{changes.slice(0, 4).map((change) => <span key={change.path} title={change.path}>{shortPath(change.path, cwd)}</span>)}</span>
      <button className="tbtn" type="button" onClick={onReview}>Granska</button>
    </div>
  );
}

function TurnView({ turn, last, working, cwd, onReview }: { turn: Turn; last: boolean; working: boolean; cwd: string; onReview: (turn: Turn) => void }) {
  const streaming = last && working;
  return (
    <>
      {turn.user && <div className={`you${turn.user.local ? " pending" : ""}`}>{turn.user.text}</div>}
      <Activity turn={turn} working={streaming && turn.answer.length === 0} cwd={cwd} />
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
    </>
  );
}

/** The step the agent is on, as one shimmering line. */
function CurrentStep({ turn, now, cwd }: { turn: Turn | undefined; now: number; cwd: string }) {
  const step = turn?.steps.at(-1);
  let text = "Tänker";
  let since = turn?.startedAt;
  if (turn && turn.answer.length > 0) text = "Skriver";
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
    case "allow_once": return "Ja";
    case "allow_always": return command ? <>Ja, och fråga inte igen för <code>{command.split(" ").slice(0, 2).join(" ")}</code></> : "Ja, och fråga inte igen";
    case "reject_once": return `Nej, och säg vad ${agentName} ska göra i stället`;
    case "reject_always": return "Nej, aldrig";
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
    ? `Ska ${agentName} köra planen?`
    : request.toolCall.kind === "edit" && files.length > 0
      ? `Får ${agentName} ändra ${files.join(", ")}?`
      : command ? `Får ${agentName} köra det här?` : `Får ${agentName} fortsätta?`;
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

interface FileHit { path: string }

function useFileSearch(query: string | null): FileHit[] {
  const [hits, setHits] = useState<FileHit[]>([]);
  useEffect(() => {
    if (query === null || !token) { setHits([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/files?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((response) => (response.ok ? response.json() : { files: [] }))
        .then((value: { files: string[] }) => { if (!cancelled) setHits(value.files.map((path) => ({ path }))); })
        .catch(() => { if (!cancelled) setHits([]); });
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
    <span className="ring" title="Använd kontext">
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

function Dock({ session, info, now }: { session: AcpSession; info: HostInfo; now: number }) {
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [selectedHit, setSelectedHit] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
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
  const hits = useFileSearch(mention ? mention.query : null);
  const agentName = info.agent.name;

  const blocksFor = useCallback((text: string): ContentBlock[] => {
    const blocks: ContentBlock[] = [{ type: "text", text }];
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const path = match[1];
      blocks.push({ type: "resource_link", uri: `file://${info.cwd.replace(/\/$/, "")}/${path}`, name: path });
    }
    return blocks;
  }, [info.cwd]);

  // A queued message goes once the turn ends.
  useEffect(() => {
    if (prompting || working || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void session.prompt(blocksFor(next));
  }, [prompting, working, queue, session, blocksFor]);

  const submit = (how: "send" | "queue") => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMention(null);
    if (how === "queue" && (prompting || working)) { setQueue((items) => [...items, text]); return; }
    if (prompting || working) { void session.steer(blocksFor(text)); return; }
    void session.prompt(blocksFor(text));
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
    <div className="dock">
      <div className="inner">
        {mention && hits.length > 0 && (
          <div className="pop" role="listbox" aria-label="Filer">
            <div className="gh">Filer</div>
            {hits.slice(0, 8).map((hit, index) => (
              <div key={hit.path} role="option" aria-selected={index === selectedHit} className={`it${index === selectedHit ? " sel" : ""}`}
                onMouseDown={(event) => { event.preventDefault(); pick(hit.path); }} onMouseEnter={() => setSelectedHit(index)}>
                <span className="p">{hit.path}</span>
              </div>
            ))}
          </div>
        )}
        {queue.map((text, index) => <div className="qd" key={index}>{text} – skickas när turen är klar</div>)}
        {busy && !asking && (
          <div className="status">
            <span>{turnStart !== undefined ? `Arbetar i ${duration(now - turnStart)}` : "Arbetar"}</span>
            <span className="sp" />
            <span><kbd>⏎</kbd> styr · <kbd>⌥⏎</kbd> köar · <kbd>esc</kbd> stoppar</span>
          </div>
        )}
        <form className="box" onSubmit={(event) => { event.preventDefault(); submit("send"); }}>
          <textarea
            ref={input}
            className="input"
            value={draft}
            rows={1}
            placeholder={busy ? `Styr ${agentName} medan den arbetar` : `Fråga ${agentName}, @ för filer`}
            onChange={(event) => {
              setDraft(event.target.value);
              setMention(mentionAt(event.target.value, event.target.selectionStart ?? event.target.value.length));
              setSelectedHit(0);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 240)}px`;
            }}
            onKeyDown={(event) => {
              if (mention && hits.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedHit((index) => (index + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.min(hits.length, 8));
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
            <button className="icon" type="button" aria-label="Lägg till en fil" onClick={() => {
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
                <select value={modes!.currentModeId} onChange={(event) => void session.setMode(event.target.value)} aria-label="Läge">
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
            {busy
              ? <button className="go" type="button" aria-label="Stoppa" onClick={() => void session.cancel()}>
                  <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.3" fill="currentColor" /></svg>
                </button>
              : <button className={`go${draft.trim() ? "" : " off"}`} type="submit" aria-label="Skicka" disabled={!draft.trim()}>
                  <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>}
          </div>
        </form>
      </div>
    </div>
  );
}

function PlanLine() {
  const plan = useSession((s) => s.plan);
  if (plan.length === 0 || plan.every((entry) => entry.status === "completed")) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  return (
    <details className="quiet plan-line">
      <summary>Plan, {done} av {plan.length} klara <Chevron /></summary>
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
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

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
      <div className="main">
        <div className="scroll" ref={scroller} onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}>
          <div className="col">
            {turns.length === 0 && <div className="empty">Inget i sessionen än. Skriv till {info.agent.name} nedan.</div>}
            {turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} last={index === turns.length - 1} working={working} cwd={info.cwd}
                onReview={(t) => setReview(t.changes)} />
            ))}
            {working && permissions.length === 0 && <CurrentStep turn={lastTurn} now={now} cwd={info.cwd} />}
            {permissions.map((request, index) => (
              <Ask key={request.id} request={request} agentName={info.agent.name} session={session} focused={index === 0} cwd={info.cwd} />
            ))}
          </div>
        </div>
        <PlanLine />
        <Dock session={session} info={info} now={now} />
      </div>
      {review && (
        <ReviewPane changes={review} cwd={info.cwd} agentName={info.agent.name}
          onClose={() => setReview(null)}
          onSend={(text) => { setReview(null); void (working ? session.steer : session.prompt)([{ type: "text", text }]); }} />
      )}
    </div>
  );
}

function SessionView({ info }: { info: HostInfo }) {
  const dispatch = useSession((s) => s.dispatch);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const session = useMemo(() => sessionId && token
    ? connectSession({ url: `ws://${location.host}/acp?token=${encodeURIComponent(token)}`, sessionId, cwd: info.cwd, agentId: info.agent.id, dispatch })
    : null, [info.cwd, info.agent.id, dispatch]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    session.load()
      .then(() => { if (!cancelled) { mark("loaded"); setLoaded(true); } })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const detail = reason && typeof reason === "object" && "message" in reason ? String((reason as { message: unknown }).message) : String(reason);
        setError(detail);
      });
    session.closed.then(() => { if (!cancelled) setError(`anslutningen till ${info.agent.name} stängdes`); }, () => {});
    return () => { cancelled = true; };
  }, [session, info.agent.name]);

  if (!sessionId) return <Notice>Panen har ingen {info.agent.name}-session än.</Notice>;
  if (error) return <Notice>Sessionen gick inte att öppna: {error}</Notice>;
  if (!session || !loaded) return <Notice>Öppnar sessionen…</Notice>;
  return <Conversation session={session} info={info} />;
}

function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch("/api/info", { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`värden svarade ${response.status}`))))
      .then((value: HostInfo) => { mark("info"); setInfo(value); })
      .catch((reason: Error) => setError(reason.message));
  }, []);
  if (!token) return <Notice>Sidan behöver panens token. Öppna den från Agents Next.</Notice>;
  if (error) return <Notice>Panens ACP-värd svarar inte: {error}</Notice>;
  if (!info) return <Notice>Ansluter…</Notice>;
  return <SessionView info={info} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
