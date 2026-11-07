// Coordinators and workers as the view shows them: a wake-up as an event row with chips for the
// workers and the message, a worker's brief as the coordinator's (folded), the coordination
// commands an agent runs as event rows, a line at the top of a worker's view naming its
// coordinator and task, and an orange row for each worker that waits on you.
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { Chip, ChipHostContext, NamedChip, PeekContext } from "./chips";
import { describeAgentEvent, needsUser, tasksIn, useCoordination, workerNamed, type AgentEvent, type CoordinationPane } from "./coordination";

const Markdown = lazy(() => import("./markdown"));

function Spark() {
  return <svg className="spark" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8l-6.4 6.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
}

/** A worker as a chip: its task's name, its pane's status dot; a click shows its pane. */
export function WorkerChip({ task, pane }: { task: string; pane?: string }) {
  const coordination = useCoordination();
  const worker = workerNamed(coordination, task);
  const id = worker?.pane ?? pane;
  if (!id) return <code>{task}</code>;
  return <Chip target={{ kind: "pane", id, state: worker?.status }} label={task} />;
}

/** "Worker ios-tests is done; Worker ui is blocked" with the workers as chips. */
function SummaryWithWorkers({ summary }: { summary: string }) {
  const tasks = tasksIn(summary);
  if (tasks.length === 0) return <>{summary}</>;
  const parts: ReactNode[] = [];
  let rest = summary;
  for (const task of tasks) {
    const at = rest.indexOf(`Worker ${task}`);
    if (at < 0) continue;
    parts.push(rest.slice(0, at), <WorkerChip key={`${task}-${parts.length}`} task={task} />);
    rest = rest.slice(at + `Worker ${task}`.length);
  }
  parts.push(rest);
  return <>{parts}</>;
}

/** A wake-up or message from the coordination (⟢ agents · …): one quiet row, not your words. */
export function DeliveryRow({ summary, file, at }: { summary: string; file?: string; at?: number }) {
  return (
    <div className="event delivery" title={at ? new Date(at).toLocaleString() : undefined}>
      <Spark />
      <span className="what"><SummaryWithWorkers summary={summary} /></span>
      {file && <NamedChip name={file} label="message" fallback={<span className="dim">{file.split("/").pop()}</span>} />}
    </div>
  );
}

/** The text of a file the coordination wrote (a brief, a report), read through the view's host. */
function useProgramText(path: string | null): string | null | undefined {
  const host = useContext(ChipHostContext);
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!path || !host) return;
    let live = true;
    host.hostJson<{ text: string }>(`/api/text?path=${encodeURIComponent(path)}`).then((value) => { if (live) setText(value.text); }, () => { if (live) setText(null); });
    return () => { live = false; };
  }, [path, host]);
  return text;
}

/** A worker's first prompt, as the brief its coordinator wrote: folded to its first lines. */
export function BriefRow({ task, brief, prompt, respawn }: { task: string; brief: string; prompt: string; respawn: boolean }) {
  const coordinator = useCoordination((state) => state.coordinator);
  const text = useProgramText(brief);
  const [open, setOpen] = useState(false);
  // The brief file starts with its title and where it came from; the brief itself is under "## Brief".
  const body = text ? (text.split(/^## Brief\s*$/m)[1] ?? text).split(/^## /m)[0].trim() : null;
  const lines = body?.split("\n") ?? [];
  const folds = lines.length > 6;
  return (
    <div className="brief">
      <div className="event">
        <Spark />
        <span className="what">
          {respawn ? "Taken over from an earlier worker: " : "Brief from the coordinator"}
          {coordinator && <> <Chip target={{ kind: "pane", id: coordinator.pane, state: coordinator.status }} label={coordinator.title ?? coordinator.pane} /></>}
          {" · task "}<WorkerChip task={task} />
        </span>
        <NamedChip name={brief} label="brief" fallback={<span />} />
      </div>
      {body && (
        <>
          <div className={`brief-body${folds && !open ? " folded" : ""}`}>
            <Suspense fallback={<p className="plain">{body}</p>}><Markdown text={folds && !open ? lines.slice(0, 6).join("\n") : body} streaming={false} /></Suspense>
          </div>
          {folds && <button type="button" className="you-more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show the whole brief"}</button>}
        </>
      )}
      {body === undefined && text === null && <details className="quiet"><summary>The prompt</summary><p className="plain">{prompt}</p></details>}
    </div>
  );
}

/** An agent's coordination command (spawn, send, report, close) as an event row. */
export function AgentEventLine({ event, failed }: { event: AgentEvent; failed: boolean }) {
  const task = event.kind === "spawn" || event.kind === "send" ? event.task : undefined;
  return (
    <div className={`event agent-event${failed ? " failed" : ""}`}>
      <Spark />
      <span className="what">
        {event.kind === "spawn" && task
          ? <>Started worker <WorkerChip task={task} pane={event.pane} />{event.agent ? ` (${event.agent})` : ""}{event.pane ? <> in <Chip target={{ kind: "pane", id: event.pane }} /></> : null}</>
          : event.kind === "send" && task
            ? <>{event.steer ? "Steered" : "Sent a message to"} <WorkerChip task={task} /></>
            : event.kind === "close" && event.tasks.length
              ? <>Closed {event.tasks.map((name, index) => <span key={name}>{index > 0 ? ", " : ""}<WorkerChip task={name} /></span>)}</>
              : describeAgentEvent(event)}
        {event.kind === "report" && event.line && <span className="dim"> · {event.line}</span>}
        {failed && <span className="del"> · failed</span>}
      </span>
    </div>
  );
}

/** At the top of a worker's view: whose worker it is, its task and its latest report. */
export function WorkerLine() {
  const { role, task, coordinator, report, reportLine } = useCoordination();
  if (role !== "worker" || !coordinator) return null;
  return (
    <div className="worker-line">
      <Spark />
      <span>Worker of <Chip target={{ kind: "pane", id: coordinator.pane, state: coordinator.status }} label={coordinator.title ?? coordinator.pane} /></span>
      {task && <span>· task <code>{task}</code></span>}
      {report && <span className="dim">· {report}{reportLine ? `: ${reportLine}` : ""}</span>}
    </div>
  );
}

type WorkerState = "needs-you" | "blocked" | "done" | "working" | "idle";

/** One word for where a worker stands, from its agent's state and its latest report. */
export function workerState(worker: CoordinationPane): WorkerState {
  if (needsUser(worker)) return "needs-you";
  if (worker.report === "blocked") return "blocked";
  if (worker.status === "working" || worker.status === "compacting" || worker.status === "pending") return "working";
  if (worker.report === "done" || worker.report === "closed" || worker.status === "done") return "done";
  return "idle";
}

const STATE_WORDS: Record<WorkerState, string> = { "needs-you": "waits for you", blocked: "blocked", done: "done", working: "working", idle: "idle" };

/** "4m", "1h 12m": how long a worker has been at it. */
export function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function StateMark({ state }: { state: WorkerState }) {
  if (state === "done") return <svg className="wk-mark done" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (state === "working") return <span className="wk-mark spin" aria-hidden="true" />;
  return <span className={`wk-mark dot ${state}`} aria-hidden="true" />;
}

const OPEN_KEY = "agents-acp-workers-open";

function storedOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

/** A coordinator's workers, docked above the field: a row of small pills (task and state) that
 *  ⌥W or the "Workers" label expands into a list with each worker's agent, state, latest report
 *  and time. A click on a pill or a row shows the worker's pane; hovering shows its last lines. A
 *  worker that waits on you turns its pill orange; the strip does not open by itself. Open or
 *  closed is remembered per pane (the page's storage belongs to the pane's host). */
export function WorkerStrip() {
  const { role, workers } = useCoordination();
  const host = useContext(ChipHostContext);
  const peek = useContext(PeekContext);
  const [open, setOpen] = useState(storedOpen);
  const [now, setNow] = useState(() => Date.now());
  const shown = workers.length > 0 && role !== "worker";
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === "KeyW") {
        event.preventDefault();
        setOpen((value) => { try { localStorage.setItem(OPEN_KEY, value ? "0" : "1"); } catch { /* no storage */ } return !value; });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  useEffect(() => {
    if (!shown || !open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [shown, open]);
  if (!shown) return null;
  const toggle = () => setOpen((value) => { try { localStorage.setItem(OPEN_KEY, value ? "0" : "1"); } catch { /* no storage */ } return !value; });
  const show = (worker: CoordinationPane) => host?.open({ kind: "pane", id: worker.pane, state: worker.status }, { alternate: false });
  const hover = (worker: CoordinationPane, element: HTMLElement) => peek?.show({ kind: "pane", id: worker.pane, state: worker.status }, element);
  return (
    <div className={`worker-strip${open ? " open" : ""}`} aria-label="Workers">
      <div className="wk-row">
        <button type="button" className="wk-label" onClick={toggle} title="Show the workers (⌥W)" aria-expanded={open}>
          Workers <svg viewBox="0 0 10 10" aria-hidden="true"><path d={open ? "M2.5 6.5L5 4l2.5 2.5" : "M2.5 4L5 6.5 7.5 4"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        </button>
        {!open && workers.map((worker) => {
          const state = workerState(worker);
          return (
            <span key={worker.pane} className={`wk-pill ${state}`} role="button" tabIndex={0} title={worker.reportLine ?? undefined}
              onClick={() => show(worker)} onKeyDown={(event) => { if (event.key === "Enter") show(worker); }}
              onMouseEnter={(event) => hover(worker, event.currentTarget)} onMouseLeave={() => peek?.hide(false)}>
              <StateMark state={state} />{worker.task ?? worker.pane}
            </span>
          );
        })}
      </div>
      {open && (
        <div className="wk-list">
          {workers.map((worker) => {
            const state = workerState(worker);
            return (
              <div key={worker.pane} className={`wk-item ${state}`} role="button" tabIndex={0}
                onClick={() => show(worker)} onKeyDown={(event) => { if (event.key === "Enter") show(worker); }}
                onMouseEnter={(event) => hover(worker, event.currentTarget)} onMouseLeave={() => peek?.hide(false)}>
                <StateMark state={state} />
                <span className="wk-name">{worker.task ?? worker.pane}</span>
                {worker.agent && <span className="wk-agent">{worker.agent}</span>}
                <span className="wk-state">{STATE_WORDS[state]}</span>
                <span className="wk-line">{worker.reportLine ?? ""}</span>
                {worker.started !== undefined && <span className="wk-time">{elapsed(now - worker.started)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
