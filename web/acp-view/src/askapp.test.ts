import { afterEach, describe, expect, it, vi } from "vitest";

describe("asking the app", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("gets what the app resolves, and nothing outside Agents Next", async () => {
    const { askApp } = await import("./chips");
    expect(await askApp(["CONTEXT.md"])).toEqual({});
    const postMessage = vi.fn(async () => ({ "CONTEXT.md": { kind: "file", path: "/p/CONTEXT.md", rel: "CONTEXT.md" } }));
    vi.stubGlobal("window", { webkit: { messageHandlers: { agentsNextACPResolve: { postMessage } } } });
    expect(await askApp(["CONTEXT.md"])).toEqual({ "CONTEXT.md": { kind: "file", path: "/p/CONTEXT.md", rel: "CONTEXT.md" } });
    expect(postMessage).toHaveBeenCalledWith({ names: ["CONTEXT.md"] });
  });
});
