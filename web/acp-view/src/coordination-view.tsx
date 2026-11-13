// Coordinators and workers as the view shows them: a wake-up as an event row with chips for the
// workers and the message, a worker's brief as the coordinator's (folded), the coordination
// commands an agent runs as event rows, and a line at the top of a worker's view naming its
// coordinator and thread. A coordinator's workers are its threads, listed in the app.
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { Chip, ChipHostContext, NamedChip } from "./chips";
import { describeAgentEvent, tasksIn, useCoordination, workerNamed, workerTitle, type AgentEvent } from "./coordination";

const Markdown = lazy(() => import("./markdown"));

function Spark() {
  return <svg className="spark" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8l-6.4 6.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
}

/** In Agents Next, a link to a thread of this pane's coordination: the app shows it among the
 *  coordinator's threads in Conversations (`agents-thread:` with no task: the pane's own). */
export function threadHref(task?: string): string {
  return `agents-thread:${task ? encodeURIComponent(task) : ""}`;
}

/** A worker as a chip: its thread's title, its pane's status mark; a click shows its pane. A
 *  worker whose pane is gone links to its thread instead, its task in the tooltip. */
export function WorkerChip({ task, pane }: { task: string; pane?: string }) {
  const coordination = useCoordination();
  const worker = workerNamed(coordination, task);
  // A pane a worker no longer has (closed, or its number reused) shows no pane: the thread.
  const id = worker?.pane ?? (coordination.workers.length === 0 && coordination.role !== "coordinator" ? pane : undefined);
  const label = workerTitle(coordination, task);
  if (!id) {
    return (
      <a className="chip thread" href={threadHref(task)} title={label === task ? "Show the thread" : `${label}\n${task} · Show the thread`}>
        <span className="nm">{label}</span>
      </a>
    );
  }
  return <Chip target={{ kind: "pane", id, state: worker?.status }} label={label} />;
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

/** A worker's first prompt, as the brief its coordinator wrote: one row, folded; a click on it
 *  shows the brief. */
export function BriefRow({ task, brief, prompt, respawn }: { task: string; brief: string; prompt: string; respawn: boolean }) {
  const coordinator = useCoordination((state) => state.coordinator);
  const text = useProgramText(brief);
  const [open, setOpen] = useState(false);
  // The brief file starts with its title and where it came from; the brief itself is under "## Brief".
  // The ROLE line says what the row says already.
  const body = text ? (text.split(/^## Brief\s*$/m)[1] ?? text).split(/^## /m)[0].trim().replace(/^\s*ROLE:[^\n]*\n+/i, "") : null;
  const canOpen = Boolean(body) || (text === null && Boolean(prompt));
  const toggle = (event: React.MouseEvent | React.KeyboardEvent) => {
    // The chips in the row open what they name.
    if ((event.target as HTMLElement).closest(".chip") || window.getSelection()?.toString()) return;
    if (canOpen) setOpen(!open);
  };
  return (
    <div className={`brief${open ? " open" : ""}`}>
      <div className={`event${canOpen ? " can-open" : ""}`} role={canOpen ? "button" : undefined} tabIndex={canOpen ? 0 : undefined} aria-expanded={canOpen ? open : undefined}
        onClick={toggle} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); } }}>
        <Spark />
        <span className="what">
          {respawn ? "Taken over from an earlier worker: " : "Brief from the coordinator"}
          {coordinator && <> <Chip target={{ kind: "pane", id: coordinator.pane, state: coordinator.status }} label={coordinator.title ?? coordinator.pane} /></>}
          {" · "}<WorkerChip task={task} />
          {" "}<NamedChip name={brief} label="brief" fallback={<span />} />
        </span>
        {canOpen && <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
      </div>
      {open && body && (
        <div className="brief-body">
          <Suspense fallback={<p className="plain">{body}</p>}><Markdown text={body} streaming={false} /></Suspense>
        </div>
      )}
      {open && !body && text === null && <p className="plain brief-body">{prompt}</p>}
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
/** The small square in a coordinator's colour before its name (decoration only). */
export function CoordinatorBadge({ color }: { color?: string }) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return <span className="coord-badge" style={{ background: color }} aria-hidden="true" />;
}

export function WorkerLine() {
  const { role, task, threadTitle, coordinator, report, reportLine, programName, programColor } = useCoordination();
  if (role !== "worker" || !coordinator) return null;
  return (
    <div className="worker-line">
      <Spark />
      <span className="what">
        Worker of <CoordinatorBadge color={programColor} /><Chip target={{ kind: "pane", id: coordinator.pane, state: coordinator.status }} label={programName ?? coordinator.title ?? coordinator.pane} />
        {threadTitle ? <> · <span title={task}>{threadTitle}</span></> : task && <> · task <code>{task}</code></>}
        {task && <> · <a className="threads-link" href={threadHref()} title="Show the coordinator's threads">threads</a></>}
        {report && <span className="dim"> · {report}{reportLine ? `: ${reportLine}` : ""}</span>}
      </span>
    </div>
  );
}
