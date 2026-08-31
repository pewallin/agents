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

export async function runCodexAppServerWebSocketProxy(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let endpoint: string;
  try {
    endpoint = resolveCodexAppServerProxyEndpoint(environment);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  return await new Promise<number>((resolve) => {
    const socket = new WebSocket(endpoint);
    const queuedLines: string[] = [];
    let inputBuffer = "";
    let inputEnded = false;
    let settled = false;

    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const sendLine = (line: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(line);
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
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    });

    socket.addEventListener("open", () => {
      for (const line of queuedLines.splice(0)) socket.send(line);
      if (inputEnded) socket.close(1000);
    });
    socket.addEventListener("message", (event) => {
      const message = typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
    });
    socket.addEventListener("error", () => {
      console.error(`Failed to connect to Codex app-server at ${endpoint}`);
      finish(1);
    });
    socket.addEventListener("close", (event) => {
      finish(inputEnded || event.code === 1000 ? 0 : 1);
    });

    process.stdin.resume();
  });
}
