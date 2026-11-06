import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RestartPlanner, runHostSupervisor } from "./acp-host-supervisor.js";

describe("the view host's supervisor", () => {
  it("restarts a host a moment later each time, from the start again after a healthy run, and gives up after too many", () => {
    const planner = new RestartPlanner({ delays: [100, 200, 400], healthyAfterMs: 1_000, maxRestarts: 4, windowMs: 10_000 });
    expect(planner.next(10, 0)).toEqual({ restart: true, delayMs: 100 });
    expect(planner.next(10, 1)).toEqual({ restart: true, delayMs: 200 });
    expect(planner.next(10, 2)).toEqual({ restart: true, delayMs: 400 });
    expect(planner.next(5_000, 3)).toEqual({ restart: true, delayMs: 100 });
    expect(planner.next(10, 4)).toMatchObject({ restart: false });
    // Old restarts leave the window.
    expect(planner.next(10, 20_000)).toMatchObject({ restart: true });
  });

  it("starts the host again when it ends, and ends with it when told to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-supervise-"));
    const counter = join(dir, "starts");
    writeFileSync(counter, "");
    // A host that counts its starts and ends at once.
    const host = `require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); setTimeout(() => process.exit(3), 30);`;
    const stop = new AbortController();
    const lines: string[] = [];
    const running = runHostSupervisor(["--parent", String(process.pid), "--", process.execPath, "-e", host], {
      stop: stop.signal,
      log: (line) => lines.push(line),
      policy: { delays: [20], healthyAfterMs: 60_000, maxRestarts: 50, windowMs: 60_000 },
    });
    try {
      for (let attempt = 0; attempt < 100 && readFileSync(counter, "utf8").length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(readFileSync(counter, "utf8").length).toBeGreaterThanOrEqual(3);
      expect(lines.join("")).toContain("the host exited with 3");
      stop.abort();
      expect(await running).toBe(0);
    } finally {
      stop.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
