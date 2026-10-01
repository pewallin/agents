import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPrimaryState, reportState } from "./state.js";
import { getRuntimeStateEventsPath, getStateDir } from "./paths.js";

let home = "";
const previousHome = process.env.AGENTS_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agents-exited-test-"));
  process.env.AGENTS_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("exited agents", () => {
  it("drop their pane state at once and tell watchers", () => {
    reportState("claude", "%7", "idle", { externalSessionId: "conversation-1" });
    const stateFile = join(getStateDir(), "claude-%7.json");
    expect(existsSync(stateFile)).toBe(true);

    clearPrimaryState("claude", "%7");

    expect(existsSync(stateFile)).toBe(false);
    const events = readFileSync(getRuntimeStateEventsPath(), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const last = events.at(-1);
    expect(last).toMatchObject({ entity: "primary_state", op: "remove", agent: "claude", surfaceId: "%7", externalSessionId: "conversation-1" });
    expect(last.state).toBeUndefined();
  });
});
