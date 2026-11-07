// Coordinators and workers as the view shows them: a wake-up as an event row with chips for the
// workers and the message, a worker's brief as the coordinator's (folded), the coordination
// commands an agent runs as event rows, a line at the top of a worker's view naming its
// coordinator and task, and an orange row for each worker that waits on you.
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { Chip, ChipHostContext, NamedChip } from "./chips";
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

/** In a coordinator's view: each worker that waits on you, as an orange row leading to its pane. */
export function NeedsYouRows() {
  const workers = useCoordination((state) => state.workers);
  const waiting = workers.filter(needsUser);
  if (waiting.length === 0) return null;
  return (
    <div className="needs-you">
      {waiting.map((worker: CoordinationPane) => (
        <div key={worker.pane} className="event need">
          <span className="dot" />
          <span className="what">
            <WorkerChip task={worker.task ?? worker.pane} pane={worker.pane} />
            {worker.report === "ask-user" ? " asks you" : " waits for you"}
            {worker.reportLine ? <span className="dim"> · {worker.reportLine}</span> : null}
          </span>
          <Chip target={{ kind: "pane", id: worker.pane, state: worker.status }} label="Open" />
        </div>
      ))}
    </div>
  );
}
