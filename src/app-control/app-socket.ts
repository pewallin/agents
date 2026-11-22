// @ts-nocheck
// The app's control socket: where it is, its token, one request.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fail } from "./output.js";
import { getAppRuntimeDir } from "../paths.js";

export function runtimeDirectory() {
  if (process.env.AGENTS_APP_RUNTIME_DIR) {
    return process.env.AGENTS_APP_RUNTIME_DIR;
  }
  return getAppRuntimeDir();
}

export function socketPath() {
  return process.env.AGENTS_APP_SOCKET_PATH || path.join(runtimeDirectory(), "app-control.sock");
}

export function tokenPath() {
  return process.env.AGENTS_APP_TOKEN_PATH
    || process.env.AGENTS_APP_CONTROL_TOKEN_PATH
    || path.join(runtimeDirectory(), "app-control.token");
}

// While the app restarts (an update, a relaunch) its socket refuses connections for a few
// seconds before the new app listens on it: a command waits that long before it says the app is
// not there. A socket that is not there at all is an app that does not run, and fails at once.
export function socketWaitMs() {
  const value = Number(process.env.AGENTS_APP_SOCKET_WAIT_MS);
  return Number.isFinite(value) && value >= 0 ? value : 8000;
}

const SOCKET_RETRY_MS = 250;

// A connection the socket refused (or, once it refused, a socket that is gone while the app comes
// back): nothing of the request reached the app, so it can be sent again.
export function appIsAway(error, refusedBefore = false) {
  if (error?.connected) return false;
  return error?.code === "ECONNREFUSED" || (refusedBefore && error?.code === "ENOENT");
}

export function readToken(currentSocketPath) {
  if (process.env.AGENTS_APP_TOKEN) {
    return process.env.AGENTS_APP_TOKEN;
  }
  if (!fs.existsSync(currentSocketPath)) {
    fail(
      2,
      "socketUnavailable",
      `Agents app control socket not found at ${currentSocketPath}. Start AgentsNext, and check that Settings › Agents › Let agents control the app is on.`
    );
  }
  const currentTokenPath = tokenPath();
  try {
    return fs.readFileSync(currentTokenPath, "utf8").trim();
  } catch (error) {
    fail(
      2,
      "tokenUnavailable",
      `Agents app control token not found at ${currentTokenPath}. Start AgentsNext before running this command.`
    );
  }
}
export function requestID(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function sendRequest(currentSocketPath, request) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: currentSocketPath });
    let data = "";
    let connected = false;

    client.setEncoding("utf8");
    client.on("connect", () => {
      connected = true;
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on("data", chunk => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        const line = data.slice(0, newline);
        client.end();
        resolve(line);
      }
    });
    client.on("error", error => {
      error.connected = connected;
      reject(error);
    });
    client.on("end", () => {
      if (!data.includes("\n")) {
        reject(new Error("socket closed before a newline response"));
      }
    });
  });
}

export async function requestAppControl(currentSocketPath, token, method, params, prefix = "cli") {
  const request = {
    id: requestID(prefix),
    method,
    params: { ...params, token },
  };

  let line;
  const deadline = Date.now() + socketWaitMs();
  let refused = false;
  for (;;) {
    try {
      line = await sendRequest(currentSocketPath, request);
      break;
    } catch (error) {
      if (appIsAway(error, refused) && Date.now() < deadline) {
        refused = true;
        await new Promise(resolve => setTimeout(resolve, SOCKET_RETRY_MS));
        // An app that started again wrote a new token.
        if (!process.env.AGENTS_APP_TOKEN) {
          try {
            request.params.token = fs.readFileSync(tokenPath(), "utf8").trim() || request.params.token;
          } catch {
            // Not written yet: the next try reads it again.
          }
        }
        continue;
      }
      fail(
        2,
        "socketUnavailable",
        `Could not connect to Agents app control socket at ${currentSocketPath}: ${error.message}`
      );
    }
  }

  try {
    return JSON.parse(line);
  } catch (error) {
    fail(1, "invalidResponse", `App control socket returned invalid JSON: ${error.message}`);
  }
}
