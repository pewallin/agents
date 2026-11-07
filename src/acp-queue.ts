// What the ACP view sends while its agent works, kept by the pane's host so it survives a reload
// of the view and is the same in every view of the pane:
//
// - queued messages, which a view sends as the agent's next prompt once the turn ends (one view
//   takes each: `take` answers once), and which can be edited or removed until then;
// - steered messages for an agent that takes them through the pane's steer inbox (Pi, through
//   the agents extension: docs/steer-inbox.md). An offered message the agent has not taken when
//   the turn ends is withdrawn and queued instead, so it is never lost and never sent twice.
//
// Agents that take steering over ACP itself (`_session/steering`: Codex, Claude) are steered by
// the view directly and do not come here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  /** queued: waits for the turn's end. offered: in the steer inbox for the agent to take. */
  state: "queued" | "offered";
}

export type SteerOutcome =
  | { ok: true; state: "steered" | "acknowledged" | "offered"; message: QueuedMessage }
  | { ok: false; reason: string };

/** The pane's steer inbox, as the agents hook and extension find it (docs/steer-inbox.md). */
export function steerInboxDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const serverPid = env.TMUX?.split(",")[1];
  const pane = env.TMUX_PANE;
  if (!serverPid || !pane?.startsWith("%")) return undefined;
  const home = env.AGENTS_HOME || join(env.AGENTS_SHARED_HOME || join(homedir(), ".agents"), env.AGENTS_PRODUCT_DIRNAME || "agents-app");
  return join(env.AGENTS_TMP_DIR || join(home, "runtime", "tmp"), "steer", `${serverPid}-pane-${pane.slice(1)}`);
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", pi: "Pi" };

export class MessageQueue {
  private items: QueuedMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly steeredListeners = new Set<(message: QueuedMessage, state: string) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly inbox: string | undefined,
    private readonly options: { pollMs?: number; offerWaitMs?: number; now?: () => Date } = {},
  ) {}

  list(): QueuedMessage[] {
    return this.items.map((item) => ({ ...item }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A message the agent took from the inbox, for the views to show in the conversation. */
  onSteered(listener: (message: QueuedMessage, state: string) => void): () => void {
    this.steeredListeners.add(listener);
    return () => this.steeredListeners.delete(listener);
  }

  add(text: string, state: QueuedMessage["state"] = "queued", id = randomBytes(6).toString("base64url")): QueuedMessage {
    const item: QueuedMessage = { id, text, at: (this.options.now?.() ?? new Date()).toISOString(), state };
    this.items.push(item);
    this.changed();
    return { ...item };
  }

  /** Changes a queued message's text; an offered one is the agent's to take and stays as it is. */
  edit(id: string, text: string): QueuedMessage | undefined {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.state !== "queued" || !text.trim()) return undefined;
    item.text = text;
    this.changed();
    return { ...item };
  }

  /** Removes a message: a queued one at once, an offered one if the agent has not taken it yet. */
  remove(id: string): boolean {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    if (item.state === "offered" && !this.withdraw(id)) return false;
    this.items = this.items.filter((entry) => entry.id !== id);
    this.changed();
    return true;
  }

  /** Hands a queued message to the one view that sends it: it leaves the queue. */
  take(id: string): QueuedMessage | undefined {
    const item = this.items.find((entry) => entry.id === id && entry.state === "queued");
    if (!item) return undefined;
    this.items = this.items.filter((entry) => entry !== item);
    this.changed();
    return { ...item };
  }

  /** The agent in the pane that takes steered messages from the inbox, if one does now. */
  harness(): string | undefined {
    if (!this.inbox) return undefined;
    const harness = readJson(join(this.inbox, "harness.json"));
    const pid = Number(harness?.pid);
    if (typeof harness?.harness !== "string" || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
    return harness.harness;
  }

  /** Puts a message in the steer inbox for the agent to take at its next step, and waits a moment
   *  for it to say it has. Not taken by the turn's end (`turnEnded`), it is queued instead. */
  async steer(text: string): Promise<SteerOutcome> {
    const harness = this.harness();
    if (!harness || !this.inbox) return { ok: false, reason: "the agent takes no steered messages" };
    const message = this.add(text, "offered");
    mkdirSync(this.inbox, { recursive: true });
    writeFileSync(join(this.inbox, `${message.id}.msg`), `${JSON.stringify({ id: message.id, text, at: message.at })}\n`);
    const deadline = Date.now() + (this.options.offerWaitMs ?? 3000);
    while (Date.now() < deadline) {
      const state = this.settle(message.id);
      if (state) return { ok: true, state, message };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.follow();
    return { ok: true, state: "offered", message };
  }

  /** The turn ended: what the agent did not take goes back to the queue, for the next prompt. */
  turnEnded(): void {
    let changed = false;
    for (const item of this.items) {
      if (item.state !== "offered") continue;
      if (this.settle(item.id)) continue;
      if (this.withdraw(item.id)) {
        item.state = "queued";
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** An offered message the agent has taken leaves the queue: its ack's state, else undefined. */
  private settle(id: string): "steered" | "acknowledged" | undefined {
    if (!this.inbox) return undefined;
    const ack = readJson(join(this.inbox, `${id}.ack.json`));
    const state = ack?.state;
    const taken = existsSync(join(this.inbox, `${id}.taken`));
    if (state !== "steered" && state !== "acknowledged" && !taken) return undefined;
    const item = this.items.find((entry) => entry.id === id);
    if (item) {
      this.items = this.items.filter((entry) => entry !== item);
      this.changed();
      for (const listener of this.steeredListeners) listener({ ...item }, typeof state === "string" ? state : "steered");
    }
    return state === "acknowledged" ? "acknowledged" : "steered";
  }

  /** Takes an offered message back, unless the agent took it first (the same rename decides). */
  private withdraw(id: string): boolean {
    if (!this.inbox) return true;
    try {
      renameSync(join(this.inbox, `${id}.msg`), join(this.inbox, `${id}.withdrawn`));
      return true;
    } catch {
      return false;
    }
  }

  /** Watches offered messages until the agent takes them or the turn ends. */
  private follow(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const offered = this.items.filter((item) => item.state === "offered");
      for (const item of offered) this.settle(item.id);
      if (!this.items.some((item) => item.state === "offered")) this.close();
    }, this.options.pollMs ?? 500);
    this.timer.unref?.();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export function harnessName(harness: string | undefined): string | undefined {
  return harness ? HARNESS_NAMES[harness] ?? harness : undefined;
}
