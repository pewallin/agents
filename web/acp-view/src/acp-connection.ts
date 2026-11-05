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
  load(): Promise<LoadSessionResponse>;
  prompt(blocks: ContentBlock[]): Promise<void>;
  /** Adds to the turn in progress: Codex takes it into the running turn, other agents queue it. */
  steer(blocks: ContentBlock[]): Promise<void>;
  cancel(): Promise<void>;
  answerPermission(id: string, optionId: string | null): void;
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
  setMode(modeId: string): Promise<void>;
  closed: Promise<void>;
}

export function connectSession(options: {
  url: string;
  sessionId: string;
  cwd: string;
  agentId: string;
  dispatch: (action: SessionAction) => void;
}): AcpSession {
  const { sessionId, cwd, dispatch } = options;
  const answers = new Map<string, (response: RequestPermissionResponse) => void>();
  let nextPermission = 1;

  const app = client({})
    .onNotification("session/update", ({ params }) => {
      const notification = params as SessionNotification;
      if (notification.sessionId === sessionId) dispatch({ type: "update", update: notification.update, at: Date.now() });
    })
    .onRequest("session/request_permission", ({ params }) => {
      const id = `permission-${nextPermission++}`;
      dispatch({ type: "permissionRequested", request: { id, toolCall: params.toolCall, options: params.options } });
      return new Promise<RequestPermissionResponse>((resolve) => answers.set(id, resolve));
    });

  const connection: ClientConnection = app.connect(createWebSocketStream(options.url));
  const agent = connection.agent;
  const ready = agent.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agents-acp-view", version: "1" },
  });

  return {
    async load() {
      await ready;
      dispatch({ type: "loading" });
      const response = await agent.request("session/load", { sessionId, cwd, mcpServers: [] });
      dispatch({ type: "loaded", modes: response.modes, configOptions: response.configOptions });
      return response;
    },
    async prompt(blocks) {
      const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      dispatch({ type: "promptSent", text, images: blocks.filter((block) => block.type === "image").length, at: Date.now() });
      try {
        await agent.request("session/prompt", { sessionId, prompt: blocks });
      } finally {
        dispatch({ type: "promptEnded" });
      }
    },
    async steer(blocks) {
      const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      if (options.agentId === "codex-acp") {
        dispatch({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, at: Date.now() });
        await agent.request("_session/steering", { sessionId, prompt: blocks });
        return;
      }
      await this.prompt(blocks);
    },
    async cancel() {
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
    closed: connection.closed,
  };
}
