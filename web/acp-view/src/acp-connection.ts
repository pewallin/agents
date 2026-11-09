// The view's ACP connection: the official SDK's client over the pane host's WebSocket. It feeds
// the session store and carries the view's requests to the agent.
import {
  client,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type LoadSessionResponse,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { SessionAction } from "./session-state";

export interface AcpSession {
  /** Loads the session, or with no session given starts one in the pane's directory. */
  load(): Promise<LoadSessionResponse & { sessionId: string }>;
  prompt(blocks: ContentBlock[]): Promise<void>;
  /** Adds to the turn in progress, for an agent that takes steering over ACP (`_session/steering`:
   *  Codex, Claude): "steered" when it went into the running turn, "prompted" when the turn had
   *  ended, or the agent takes no steering, and it went as a prompt of its own. */
  steer(blocks: ContentBlock[]): Promise<"steered" | "prompted">;
  /** Whether the agent takes steering over ACP (its initialize says so); known once it answers. */
  steering(): Promise<boolean>;
  /** What a prompt may hold besides text and links (initialize's promptCapabilities). */
  promptCapabilities(): Promise<{ image: boolean; embeddedContext: boolean }>;
  cancel(): Promise<void>;
  answerPermission(id: string, optionId: string | null): void;
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
  setMode(modeId: string): Promise<void>;
  /** Whether the pane's host allows each tool call the agent asks about (`_agents/allow_all`):
   *  offered for an agent whose command can run tools without asking (Kiro's -a, OpenCode's
   *  --auto), on as the command says until the view turns it off. A host that does not answer
   *  offers nothing. */
  allowAll(): Promise<AllowAll>;
  setAllowAll(on: boolean): Promise<AllowAll>;
  /** Called when another view of the pane turns it on or off. */
  onAllowAll(listener: (state: AllowAll) => void): void;
  closed: Promise<void>;
  close(): void;
}

export interface AllowAll { offered: boolean; on: boolean }

function allowAllOf(value: unknown): AllowAll {
  const state = value as { offered?: unknown; allowAll?: unknown } | null | undefined;
  return { offered: state?.offered === true, on: state?.allowAll === true };
}

/** The session is open in another view; this one may take it over (`takeOver`). */
export class OpenElsewhere extends Error {
  constructor() {
    super("The session is open in another view");
  }
}

/** The host's answer to a load of a session another view has (acp-host's OPEN_ELSEWHERE_CODE). */
const OPEN_ELSEWHERE_CODE = -32050;

/** The agent cannot open an existing session (no `session/load`), so the view cannot show it. */
export class CannotLoadSession extends Error {
  /** The agent's name and version as it gives them (initialize's agentInfo). */
  constructor(readonly agentInfo?: { name?: string; title?: string | null; version?: string }) {
    super("The agent cannot load a session");
  }
}

let ownViewId: string | undefined;
function viewId(): string {
  if (ownViewId) return ownViewId;
  // The app names its view of the pane (?view=app): any web view it makes for the pane is that view.
  const named = typeof location !== "undefined" ? new URLSearchParams(location.search).get("view") : null;
  if (named) return (ownViewId = named);
  try {
    ownViewId = sessionStorage.getItem("agents-acp-view-id") ?? undefined;
  } catch { /* no storage */ }
  if (!ownViewId) {
    ownViewId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try { sessionStorage.setItem("agents-acp-view-id", ownViewId); } catch { /* no storage */ }
  }
  return ownViewId;
}

export function connectSession(options: {
  url: string;
  /** The session to load; null starts one (a hand-off agent whose TUI had none yet). */
  sessionId: string | null;
  cwd: string;
  agentId: string;
  dispatch: (action: SessionAction) => void;
  /** Take the session over from another view that has it open. */
  takeOver?: boolean;
  /** Another view took the session over: the host ends this one. */
  onTakenOver?: () => void;
}): AcpSession {
  const { cwd, dispatch } = options;
  let sessionId = options.sessionId ?? "";
  const answers = new Map<string, (response: RequestPermissionResponse) => void>();
  let nextPermission = 1;
  let allowAllListener: ((state: AllowAll) => void) | undefined;

  const app = client({})
    .onNotification("session/update", ({ params }) => {
      const notification = params as SessionNotification;
      if (notification.sessionId === sessionId || !sessionId) dispatch({ type: "update", update: notification.update, at: Date.now() });
    })
    // The host's own notice (not ACP): a custom method needs its own params parser.
    .onNotification("_agents/taken_over", (params: unknown) => params, () => { options.onTakenOver?.(); })
    .onNotification("_agents/allow_all", (params: unknown) => params, ({ params }) => { allowAllListener?.(allowAllOf(params)); })
    .onRequest("session/request_permission", ({ params }) => {
      const id = `permission-${nextPermission++}`;
      dispatch({ type: "permissionRequested", request: { id, toolCall: params.toolCall, options: params.options } });
      return new Promise<RequestPermissionResponse>((resolve) => answers.set(id, resolve));
    });

  // The view's own id, kept while the page reloads: the host gives the session back to the same
  // view at once instead of calling it another view.
  const url = `${options.url}&view=${encodeURIComponent(viewId())}${options.takeOver ? "&takeover=1" : ""}`;
  const connection: ClientConnection = app.connect(createWebSocketStream(url));
  const agent = connection.agent;
  const ready = agent.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agents-acp-view", version: "1" },
  });

  return {
    async load() {
      const initialized = await ready;
      // The view shows a session the pane already has; an agent that cannot load one has no view.
      if (!sessionId) {
        dispatch({ type: "loading" });
        const started = await agent.request("session/new", { cwd, mcpServers: [] });
        sessionId = started.sessionId;
        dispatch({ type: "loaded", modes: started.modes, configOptions: started.configOptions });
        return { ...started, sessionId };
      }
      if (!initialized.agentCapabilities?.loadSession) throw new CannotLoadSession(initialized.agentInfo ?? undefined);
      dispatch({ type: "loading" });
      const response = await agent.request("session/load", { sessionId, cwd, mcpServers: [] }).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === OPEN_ELSEWHERE_CODE) throw new OpenElsewhere();
        throw error;
      });
      dispatch({ type: "loaded", modes: response.modes, configOptions: response.configOptions });
      return { ...response, sessionId };
    },
    async prompt(blocks) {
      dispatch({ type: "promptSent", blocks, at: Date.now() });
      try {
        await agent.request("session/prompt", { sessionId, prompt: blocks });
      } finally {
        dispatch({ type: "promptEnded" });
      }
    },
    async steer(blocks) {
      // An agent that takes no steering over ACP gets a prompt, which it runs after its turn.
      if (!(await this.steering())) {
        await this.prompt(blocks);
        return "prompted";
      }
      // promptRequired: a turn that ended meanwhile gets the message as a prompt of the view's own,
      // whose answer the view follows like any other.
      const result = await agent.request("_session/steering", {
        sessionId, prompt: blocks, _meta: { steering: { idleBehavior: "promptRequired" } },
      } as never) as { outcome?: string } | undefined;
      if (result?.outcome === "promptRequired") {
        await this.prompt(blocks);
        return "prompted";
      }
      // The agent does not show what it was steered with as a message of its own.
      const at = Date.now();
      for (const content of blocks) dispatch({ type: "update", update: { sessionUpdate: "user_message_chunk", content }, at });
      return "steered";
    },
    async promptCapabilities() {
      const initialized = await ready.catch(() => undefined);
      const capabilities = initialized?.agentCapabilities?.promptCapabilities;
      return { image: capabilities?.image === true, embeddedContext: capabilities?.embeddedContext === true };
    },
    async steering() {
      const initialized = await ready.catch(() => undefined);
      const meta = (initialized as { _meta?: { steering?: { supported?: unknown } } } | undefined)?._meta;
      return meta?.steering?.supported === true || options.agentId === "codex-acp";
    },
    async cancel() {
      // Codex interrupts the thread's turn, whichever client started it (the pane's TUI too).
      dispatch({ type: "stopped" });
      await agent.notify("session/cancel", { sessionId });
    },
    answerPermission(id, optionId) {
      const resolve = answers.get(id);
      answers.delete(id);
      dispatch({ type: "permissionAnswered", id });
      resolve?.({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    },
    async setConfigOption(configId, value) {
      const response = await agent.request("session/set_config_option", { sessionId, configId, value } as never) as
        { configOptions?: unknown };
      if (Array.isArray(response?.configOptions)) {
        dispatch({ type: "update", update: { sessionUpdate: "config_option_update", configOptions: response.configOptions } as never });
      }
    },
    async setMode(modeId) {
      await agent.request("session/set_mode", { sessionId, modeId });
      dispatch({ type: "update", update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
    },
    async allowAll() {
      await ready.catch(() => undefined);
      return allowAllOf(await agent.request("_agents/allow_all", {} as never).catch(() => undefined));
    },
    async setAllowAll(on) {
      return allowAllOf(await agent.request("_agents/allow_all", { allowAll: on } as never));
    },
    onAllowAll(listener) {
      allowAllListener = listener;
    },
    closed: connection.closed,
    close: () => connection.close(),
  };
}
