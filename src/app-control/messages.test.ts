import { describe, expect, it } from "vitest";
import { readQueued, threadEvent } from "./messages.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("a message in a coordinator's thread", () => {
  it("says who wrote what in the line itself, its first 200 characters", () => {
    const long = "x".repeat(300);
    const user = threadEvent("/p", "wi01-dts", "user", `Kan du ta med Safari också? ${long}`);
    expect(user.summary.startsWith('Worker wi01-dts got a message from the user: "Kan du ta med Safari också? ')).toBe(true);
    expect(user.summary.length).toBeLessThanOrEqual(260);
    expect(user.event).toEqual({ kind: "thread", thread: "wi01-dts", from: "agents" });
    expect(user.text).toContain("agents session-log --task wi01-dts --program /p --json");
    const reply = threadEvent("/p", "wi01-dts", "worker", "Klart, Safari är med.");
    expect(reply.summary).toBe('Worker wi01-dts answered the user: "Klart, Safari är med."');
    expect(reply.event.from).toBe("worker:wi01-dts");
  });

  it("keeps its preview when it waits in the queue", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-event-"));
    const event = threadEvent("/p", "t1", "worker", "y".repeat(250));
    const file = path.join(dir, "1-m.txt");
    fs.writeFileSync(file, `${JSON.stringify({ id: "m", summary: event.summary, text: event.text, event: event.event })}\n`);
    expect(readQueued(file).summary).toBe(event.summary);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
