export function resolveCodexAppServerProxyEndpoint(environment: NodeJS.ProcessEnv): string {
  const value = environment.AGENTS_CODEX_APP_SERVER_URL?.trim();
  if (!value) throw new Error("AGENTS_CODEX_APP_SERVER_URL is required");

  const url = new URL(value);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Codex app-server proxy requires a loopback WebSocket endpoint");
  }
  return url.href;
}

export function shouldRunCodexAppServerProxy(
  args: string[],
  environment: NodeJS.ProcessEnv,
): boolean {
  return Boolean(environment.AGENTS_CODEX_APP_SERVER_URL?.trim())
    && args.includes("app-server");
}

export interface CodexAppServerProxyOptions {
  /** How long a connection that is refused is tried again: the app-server may still be starting. */
  connectWindowMs?: number;
  retryDelayMs?: number;
}

export async function runCodexAppServerWebSocketProxy(
  environment: NodeJS.ProcessEnv = process.env,
  options: CodexAppServerProxyOptions = {},
): Promise<number> {
  let endpoint: string;
  try {
    endpoint = resolveCodexAppServerProxyEndpoint(environment);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const connectDeadline = Date.now() + (options.connectWindowMs ?? 3_000);
  const retryDelayMs = options.retryDelayMs ?? 200;

  return await new Promise<number>((resolve) => {
    const queuedLines: string[] = [];
    let socket: WebSocket;
    let inputBuffer = "";
    let inputEnded = false;
    let opened = false;
    let settled = false;

    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const sendLine = (line: string) => {
      if (opened && socket.readyState === WebSocket.OPEN) socket.send(line);
      else queuedLines.push(line);
    };
    const flushInput = () => {
      let newlineIndex: number;
      while ((newlineIndex = inputBuffer.indexOf("\n")) >= 0) {
        const line = inputBuffer.slice(0, newlineIndex).trimEnd();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        if (line) sendLine(line);
      }
    };

    const connect = () => {
      const attempt = new WebSocket(endpoint);
      socket = attempt;
      let retrying = false;
      attempt.addEventListener("open", () => {
        opened = true;
        for (const line of queuedLines.splice(0)) attempt.send(line);
        if (inputEnded) attempt.close(1000);
      });
      attempt.addEventListener("message", (event) => {
        const message = typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
      });
      attempt.addEventListener("error", () => {
        // Node's WebSocket can raise an error while closing after stdin ended; that is a clean end.
        if (opened && inputEnded) return finish(0);
        if (!opened && Date.now() < connectDeadline) {
          retrying = true;
          setTimeout(connect, retryDelayMs);
          return;
        }
        console.error(`${opened ? "Lost connection to" : "Failed to connect to"} Codex app-server at ${endpoint}`);
        finish(1);
      });
      attempt.addEventListener("close", (event) => {
        // A refused connection that is tried again is no end.
        if (retrying) return;
        finish(inputEnded || event.code === 1000 ? 0 : 1);
      });
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      inputBuffer += chunk;
      flushInput();
    });
    process.stdin.on("end", () => {
      inputEnded = true;
      const line = inputBuffer.trim();
      if (line) sendLine(line);
      inputBuffer = "";
      if (opened && socket.readyState === WebSocket.OPEN) socket.close(1000);
    });

    connect();
    process.stdin.resume();
  });
}
