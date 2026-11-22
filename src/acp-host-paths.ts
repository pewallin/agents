// Where a pane's ACP host keeps what others read of it: its metadata (url, token, process) and
// its agent's latest plan (acp-plan.ts), and when the user last prompted from its view.
import { join } from "node:path";
import { getRuntimeTempDir } from "./paths.js";

/** Where the panes' ACP hosts keep their metadata (paths.ts: AGENTS_TMP_DIR, else the agents
 *  home's runtime/tmp). `acp-session` and `codex-session` start with this rule, and Agents Next
 *  finds a pane's host by it (AgentsPaths in AgentsCore). */
export function acpHostRuntimeTempDir(env: NodeJS.ProcessEnv = process.env): string {
  return getRuntimeTempDir(env);
}

export function acpHostMetadataPath(runtimeTempDir: string, paneId: string): string {
  const normalized = paneId.trim().replace(/^%/, "pane-").replace(/[^A-Za-z0-9._-]/g, "-");
  return join(runtimeTempDir, "acp-session", `${normalized || "pane-unknown"}.json`);
}

export function acpHostPlanPath(metadataPath: string): string {
  return metadataPath.replace(/\.json$/, ".plan.json");
}

/** When the user last sent a prompt from the pane's ACP view: `{ "at": <ISO time> }`. A worker's
 *  question for the user closes with their next prompt (app-control supervisor.ts). */
export function acpHostPromptPath(metadataPath: string): string {
  return metadataPath.replace(/\.json$/, ".prompt.json");
}
