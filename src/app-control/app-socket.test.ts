// The app's control socket while the app restarts: a command waits for it a few seconds.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { appIsAway, requestAppControl } from "./app-socket.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function answeringServer(socket: string, tokens: string[]) {
  const server = net.createServer(connection => {
    connection.setEncoding("utf8");
    connection.on("data", chunk => {
      const request = JSON.parse(String(chunk).trim());
      tokens.push(request.params.token);
      connection.end(`${JSON.stringify({ id: request.id, ok: true, result: { method: request.method } })}\n`);
    });
  });
  return new Promise<net.Server>(resolve => server.listen(socket, () => resolve(server)));
}

// A socket file nobody listens on: bound, moved aside while its server closes, put back.
async function staleSocket(socket: string) {
  const aside = `${socket}.aside`;
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(socket, () => resolve()));
  fs.renameSync(socket, aside);
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.renameSync(aside, socket);
}

test("a request waits for an app that is starting again, with the token it writes", async () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "as-"));
  const socket = path.join(dir, "s.sock");
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "old\n");
  process.env.AGENTS_APP_TOKEN_PATH = tokenFile;
  delete process.env.AGENTS_APP_TOKEN;
  process.env.AGENTS_APP_SOCKET_WAIT_MS = "4000";
  const tokens: string[] = [];
  // The quitting app's socket is still there and refuses until the new app listens on it.
  await staleSocket(socket);
  let server: net.Server | undefined;
  setTimeout(async () => {
    fs.rmSync(socket, { force: true });
    fs.writeFileSync(tokenFile, "new\n");
    server = await answeringServer(socket, tokens);
  }, 600);
  try {
    const response = await requestAppControl(socket, "old", "control.list", {});
    assert.equal(response.ok, true);
    assert.deepEqual(tokens, ["new"]);
  } finally {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only a connection that never reached the app counts as an app that is away", () => {
  assert.equal(appIsAway(Object.assign(new Error("refused"), { code: "ECONNREFUSED", connected: false })), true);
  // A socket that is not there is an app that does not run, unless it refused a moment ago.
  assert.equal(appIsAway(Object.assign(new Error("gone"), { code: "ENOENT", connected: false })), false);
  assert.equal(appIsAway(Object.assign(new Error("gone"), { code: "ENOENT", connected: false }), true), true);
  assert.equal(appIsAway(Object.assign(new Error("reset"), { code: "ECONNRESET", connected: true })), false);
  assert.equal(appIsAway(Object.assign(new Error("refused"), { code: "ECONNREFUSED", connected: true })), false);
});
