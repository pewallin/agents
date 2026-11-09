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

    client.setEncoding("utf8");
    client.on("connect", () => {
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
    client.on("error", reject);
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
  try {
    line = await sendRequest(currentSocketPath, request);
  } catch (error) {
    fail(
      2,
      "socketUnavailable",
      `Could not connect to Agents app control socket at ${currentSocketPath}: ${error.message}`
    );
  }

  try {
    return JSON.parse(line);
  } catch (error) {
    fail(1, "invalidResponse", `App control socket returned invalid JSON: ${error.message}`);
  }
}
