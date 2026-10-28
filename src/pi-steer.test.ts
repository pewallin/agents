import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createSteerInbox, steerInboxDirectory } from "../extensions/pi/dustbot-reporting";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inbox() {
  const dir = mkdtempSync(join(tmpdir(), "agents-pi-steer-"));
  directories.push(dir);
  const sent: Array<{ text: string; options: unknown }> = [];
  const steer = createSteerInbox({ sendUserMessage: ((text: string, options: unknown) => sent.push({ text, options })) as any }, dir);
  const ack = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.ack.json`), "utf8")).state;
  return { dir, sent, steer, ack };
}

describe("Pi steer inbox", () => {
  it("is the pane's inbox on its tmux server", () => {
    expect(steerInboxDirectory({ TMUX: "/tmp/sock,4242,0", TMUX_PANE: "%7", AGENTS_HOME: "/h" })).toBe("/h/runtime/tmp/steer/4242-pane-7");
    expect(steerInboxDirectory({ TMUX: "/tmp/sock,4242,0", TMUX_PANE: "%7", AGENTS_TMP_DIR: "/t" })).toBe("/t/steer/4242-pane-7");
    expect(steerInboxDirectory({ TMUX_PANE: "%7" })).toBeUndefined();
  });

  it("hands each message to Pi as a steer once, then acknowledges it when Pi delivers it", () => {
    const { dir, sent, steer, ack } = inbox();
    steer.announce();
    expect(JSON.parse(readFileSync(join(dir, "harness.json"), "utf8"))).toMatchObject({ harness: "pi", pid: process.pid });

    writeFileSync(join(dir, "m-1.msg"), JSON.stringify({ id: "m-1", text: "From coordinator: use v2" }));
    expect(steer.take()).toBe(1);
    expect(sent).toEqual([{ text: "From coordinator: use v2", options: { deliverAs: "steer" } }]);
    expect(ack("m-1")).toBe("steered");
    expect(existsSync(join(dir, "m-1.msg"))).toBe(false);
    expect(steer.take()).toBe(0);
    expect(sent).toHaveLength(1);

    steer.delivered({ role: "assistant", content: [{ type: "text", text: "From coordinator: use v2" }] });
    expect(ack("m-1")).toBe("steered");
    steer.delivered({ role: "user", content: [{ type: "text", text: "From coordinator: use v2" }] });
    expect(ack("m-1")).toBe("acknowledged");
  });

  it("leaves a withdrawn message alone", () => {
    const { dir, sent, steer } = inbox();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m-2.msg"), JSON.stringify({ id: "m-2", text: "late" }));
    renameSync(join(dir, "m-2.msg"), join(dir, "m-2.withdrawn"));
    expect(steer.take()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
