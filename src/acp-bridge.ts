// What an agent pane's ACP host does with the app and the pane's tmux, for its web view:
//   - opens a review of the agent's changes as a pane beside it, through Agents Next's app-control
//     socket (`workspace.open-web-page`, placed in a split);
//   - lists the panes of its tmux session for the view's @ menu and reads what one of them shows;
//   - relays a review page's comments back to the view that asked for the review.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { getAppRuntimeDir } from "./paths.js";

export interface AppControlTarget {
  socketPath: string;
  tokenPath: string;
}

/** Where the app's control socket is, as agents-app-control finds it. */
export function appControlTarget(env: NodeJS.ProcessEnv = process.env): AppControlTarget {
  const runtime = getAppRuntimeDir(env);
  return {
    socketPath: env.AGENTS_APP_SOCKET_PATH || join(runtime, "app-control.sock"),
    tokenPath: env.AGENTS_APP_TOKEN_PATH || env.AGENTS_APP_CONTROL_TOKEN_PATH || join(runtime, "app-control.token"),
  };
}

/** One app-control request; resolves with its result, rejects when the app is not there or refuses. */
export function appControlRequest(
  target: AppControlTarget,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = readFileSync(target.tokenPath, "utf8").trim();
    } catch {
      reject(new Error("Agents Next is not running"));
      return;
    }
    const client = createConnection({ path: target.socketPath });
    const timer = setTimeout(() => { client.destroy(); reject(new Error("Agents Next did not answer")); }, timeoutMs);
    let data = "";
    client.setEncoding("utf8");
    client.on("connect", () => {
      client.write(`${JSON.stringify({ id: `acp-host-${Date.now()}`, method, params: { ...params, token } })}\n`);
    });
    client.on("data", (chunk: string) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      client.end();
      try {
        const reply = JSON.parse(data.slice(0, newline)) as { ok?: boolean; result?: unknown; error?: { message?: string } };
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error?.message ?? "Agents Next refused"));
      } catch (error) {
        reject(error);
      }
    });
    client.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Opens a web page beside the pane: a tab in the slot right of it, or a split on the right. */
export async function openPageBeside(target: AppControlTarget, paneId: string, url: string): Promise<void> {
  await appControlRequest(target, "control.invoke", {
    id: "workspace.open-web-page",
    pane: `local:${paneId}`,
    url,
    // As Codex opens things: a tab in the slot right of the pane, or a split on the right.
    placement: "beside",
  });
}

export interface PaneSummary {
  id: string;
  command: string;
  title: string;
}

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** The other panes of this pane's tmux session (tmux is reached through the pane's own $TMUX). */
export async function sessionPanes(ownPane: string): Promise<PaneSummary[]> {
  const output = await tmux(["list-panes", "-s", "-t", ownPane, "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_title}"]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [id, command, title] = line.split("\t");
    return { id, command: command ?? "", title: title ?? "" };
  }).filter((pane) => pane.id !== ownPane);
}

/** What a pane of the same session shows, its last lines. */
export async function paneText(pane: string, lines = 200): Promise<string> {
  if (!/^%\d+$/.test(pane)) throw new Error("not a pane id");
  const text = await tmux(["capture-pane", "-p", "-J", "-t", pane, "-S", `-${Math.max(1, Math.min(lines, 2000))}`]);
  return text.replace(/\s+$/, "");
}

/** Reviews the view hands over, kept while the host runs (a few, newest last). */
export class ReviewStore {
  private readonly reviews = new Map<string, unknown>();

  put(payload: unknown): string {
    const id = randomBytes(9).toString("base64url");
    this.reviews.set(id, payload);
    while (this.reviews.size > 20) this.reviews.delete(this.reviews.keys().next().value!);
    return id;
  }

  get(id: string): unknown {
    return this.reviews.get(id);
  }
}
