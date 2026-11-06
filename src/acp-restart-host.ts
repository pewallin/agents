// Restarts the ACP view host of a pane whose agent shares its session live (Codex under
// `agents codex-session`): `agents acp-restart-host --pane %N`. The agent is not touched; the new
// host attaches to the pane's app-server again. A host its supervisor runs is ended and comes
// back; a pane without one gets a supervised host of its own.
//
// Prints one JSON line: {ok, reason?, url?}. A hand-off agent's host is part of the process that
// runs its TUI: there the answer says to restart the agent in ACP mode instead.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acpHostMetadataPath, readAcpHostMetadata } from "./acp-host.js";
import { getSelfArgv } from "./paths.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pane's Codex app-server, as codex-session records it, while codex-session runs. */
export function paneAppServer(runtimeTempDir: string, paneId: string): { url: string; processId: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(runtimeTempDir, "codex-app-server", `pane-${paneId.replace(/^%/, "")}.json`), "utf8")) as { url?: unknown; processId?: unknown };
    if (typeof value.url !== "string" || typeof value.processId !== "number" || !alive(value.processId)) return undefined;
    return { url: value.url, processId: value.processId };
  } catch {
    return undefined;
  }
}

export async function runAcpRestartHost(args: string[], runtimeTempDir: string): Promise<number> {
  const paneIndex = args.indexOf("--pane");
  const paneId = paneIndex >= 0 ? args[paneIndex + 1] : "";
  const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!/^%\d+$/.test(paneId)) {
    say({ ok: false, reason: "acp-restart-host needs --pane %N" });
    return 2;
  }
  const appServer = paneAppServer(runtimeTempDir, paneId);
  if (!appServer) {
    say({ ok: false, reason: "This pane's agent shares no running app-server with a view: restart it in ACP mode." });
    return 1;
  }
  const metadataPath = acpHostMetadataPath(runtimeTempDir, paneId);
  const before = readAcpHostMetadata(metadataPath);
  if (before && alive(before.processId)) {
    try { process.kill(before.processId, "SIGTERM"); } catch { /* gone */ }
  }
  const restarted = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = readAcpHostMetadata(metadataPath);
      if (now && now.processId !== before?.processId && alive(now.processId)) return now;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  };
  // A supervised host comes back by itself.
  let host = await restarted(4_000);
  if (!host) {
    const self = getSelfArgv();
    let cwd = process.cwd();
    try {
      cwd = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_current_path}"], { encoding: "utf8", timeout: 3_000 }).trim() || cwd;
    } catch { /* the CLI's own */ }
    const directory = join(runtimeTempDir, "codex-app-server");
    mkdirSync(directory, { recursive: true });
    const log = openSync(join(directory, `pane-${paneId.replace(/^%/, "")}-host-${Date.now()}.log`), "a");
    const child = spawn(self[0], [
      ...self.slice(1), "acp-host-supervise", "--parent", String(appServer.processId), "--",
      self[0], ...self.slice(1), "acp-session", "--agent", "codex-acp", "--pane", paneId, "--app-server", appServer.url, "--cwd", cwd,
    ], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    host = await restarted(10_000);
  }
  if (!host) {
    say({ ok: false, reason: "The view host did not start again; its log is in the runtime directory's codex-app-server folder." });
    return 1;
  }
  say({ ok: true, url: host.url });
  return 0;
}
