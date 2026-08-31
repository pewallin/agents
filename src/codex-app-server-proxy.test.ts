import { describe, expect, it } from "vitest";
import {
  resolveCodexAppServerProxyEndpoint,
  shouldRunCodexAppServerProxy,
} from "./codex-app-server-proxy.js";

describe("resolveCodexAppServerProxyEndpoint", () => {
  it("accepts only a pane-local loopback WebSocket endpoint", () => {
    expect(resolveCodexAppServerProxyEndpoint({
      AGENTS_CODEX_APP_SERVER_URL: "ws://127.0.0.1:43123",
    })).toBe("ws://127.0.0.1:43123/");

    expect(() => resolveCodexAppServerProxyEndpoint({})).toThrow(/required/);
    expect(() => resolveCodexAppServerProxyEndpoint({
      AGENTS_CODEX_APP_SERVER_URL: "ws://example.com:43123",
    })).toThrow(/loopback/);
  });
});

describe("shouldRunCodexAppServerProxy", () => {
  it("accepts the config flags that codex-web places before app-server", () => {
    const environment = { AGENTS_CODEX_APP_SERVER_URL: "ws://127.0.0.1:43123" };

    expect(shouldRunCodexAppServerProxy(["app-server"], environment)).toBe(true);
    expect(shouldRunCodexAppServerProxy([
      "-c",
      "features.unified_exec=true",
      "app-server",
    ], environment)).toBe(true);
    expect(shouldRunCodexAppServerProxy(["list"], environment)).toBe(false);
    expect(shouldRunCodexAppServerProxy(["app-server"], {})).toBe(false);
  });
});
