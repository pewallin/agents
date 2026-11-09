import { describe, expect, it } from "vitest";
import { getAppRuntimeDir, getProductHome, getRuntimeTempDir, getSharedAppControlPath } from "./paths.js";

// The same rules as Agents Next's AgentsPaths (AgentsCore): both sides must find the same folders.
describe("folders shared with Agents Next", () => {
  const base = { HOME: "/Users/me" };

  it("puts the ordinary app's files under ~/.agents/agents-app", () => {
    expect(getProductHome(base)).toBe("/Users/me/.agents/agents-app");
    expect(getRuntimeTempDir(base)).toBe("/Users/me/.agents/agents-app/runtime/tmp");
    expect(getAppRuntimeDir(base)).toBe("/Users/me/.agents/agents-app/app/runtime");
    expect(getSharedAppControlPath(base)).toBe("/Users/me/.agents/agents-app/bin/agents-app-control");
  });

  it("keeps a private instance's files in its own folder", () => {
    const env = { ...base, AGENTS_PRODUCT_DIRNAME: "agents-test-1" };
    expect(getRuntimeTempDir(env)).toBe("/Users/me/.agents/agents-test-1/runtime/tmp");
    expect(getAppRuntimeDir(env)).toBe("/Users/me/.agents/agents-test-1/app/runtime");
  });

  it("lets the overrides win in the same order", () => {
    expect(getRuntimeTempDir({ ...base, AGENTS_HOME: "/h" })).toBe("/h/runtime/tmp");
    expect(getRuntimeTempDir({ ...base, AGENTS_HOME: "/h", AGENTS_RUNTIME_DIR: "/r" })).toBe("/r/tmp");
    expect(getRuntimeTempDir({ ...base, AGENTS_TMP_DIR: "/t" })).toBe("/t");
    expect(getProductHome({ ...base, AGENTS_SHARED_HOME: "/s" })).toBe("/s/agents-app");
    // AGENTS_HOME moves the CLI's state, not the app's own folder.
    expect(getAppRuntimeDir({ ...base, AGENTS_HOME: "/h" })).toBe("/Users/me/.agents/agents-app/app/runtime");
  });
});
