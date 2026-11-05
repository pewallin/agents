import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CannotLoadSession, OpenElsewhere, connectSession } from "./acp-connection";

describe("connectSession", () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  async function agent(loadSession: boolean, takeOver = false, openElsewhere = false): Promise<{ url: string; methods: string[]; urls: string[] }> {
    const methods: string[] = [];
    const urls: string[] = [];
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (ws, request) => { urls.push(request.url ?? ""); ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      methods.push(message.method);
      if (message.method === "initialize") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession } } }));
      } else if (message.method === "session/load" && openElsewhere && !request.url?.includes("takeover=1")) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32050, message: "The session is open in another view" } }));
      } else if (message.method === "session/load") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        if (takeOver) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "_agents/taken_over", params: {} }));
      }
    }); });
    await new Promise((resolve) => server!.once("listening", resolve));
    return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/acp?token=t`, methods, urls };
  }

  it("says so when the agent cannot load a session, and asks it nothing more", async () => {
    const { url, methods } = await agent(false);
    const session = connectSession({ url, sessionId: "s", cwd: "/", agentId: "old", dispatch: () => {} });
    await expect(session.load()).rejects.toBeInstanceOf(CannotLoadSession);
    expect(methods).toEqual(["initialize"]);
  });

  it("loads the session when the agent can", async () => {
    const { url, methods } = await agent(true);
    const actions: string[] = [];
    const session = connectSession({ url, sessionId: "s", cwd: "/", agentId: "codex-acp", dispatch: (action) => actions.push(action.type) });
    await session.load();
    expect(methods).toEqual(["initialize", "session/load"]);
    expect(actions).toEqual(["loading", "loaded"]);
  });

  it("tells the view when the host gave its session to another view", async () => {
    const { url } = await agent(true, true);
    let takenOver = false;
    const session = connectSession({ url, sessionId: "s", cwd: "/", agentId: "codex-acp", dispatch: () => {}, onTakenOver: () => { takenOver = true; } });
    await session.load();
    await expect.poll(() => takenOver).toBe(true);
  });

  it("says the session is open in another view, and takes it over when asked", async () => {
    const { url, urls } = await agent(true, false, true);
    const first = connectSession({ url, sessionId: "s", cwd: "/", agentId: "codex-acp", dispatch: () => {} });
    await expect(first.load()).rejects.toBeInstanceOf(OpenElsewhere);
    first.close();
    const taking = connectSession({ url, sessionId: "s", cwd: "/", agentId: "codex-acp", dispatch: () => {}, takeOver: true });
    await taking.load();
    expect(urls).toEqual(["/acp?token=t", "/acp?token=t&takeover=1"]);
  });
});
