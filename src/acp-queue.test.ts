import { existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageQueue, steerInboxDirectory } from "./acp-queue";

function inbox(harness = true): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-queue-"));
  if (harness) writeFileSync(join(dir, "harness.json"), JSON.stringify({ harness: "pi", pid: process.pid }));
  return dir;
}

describe("the host's message queue", () => {
  it("keeps queued messages, edits and removes them, and gives each to one view only", () => {
    const queue = new MessageQueue(undefined);
    let changes = 0;
    queue.onChange(() => { changes += 1; });
    const first = queue.add("one");
    const second = queue.add("two");
    expect(queue.edit(first.id, "one, better")?.text).toBe("one, better");
    expect(queue.remove(second.id)).toBe(true);
    expect(queue.list().map((item) => item.text)).toEqual(["one, better"]);
    expect(queue.take(first.id)?.text).toBe("one, better");
    expect(queue.take(first.id)).toBeUndefined();
    expect(changes).toBe(5);
  });

  it("finds the pane's steer inbox as the agents hook and extension do", () => {
    expect(steerInboxDirectory({ TMUX: "/tmp/s,4242,0", TMUX_PANE: "%7", AGENTS_TMP_DIR: "/x" })).toBe("/x/steer/4242-pane-7");
    expect(steerInboxDirectory({})).toBeUndefined();
  });

  it("refuses to steer when no agent in the pane takes steered messages", async () => {
    const queue = new MessageQueue(inbox(false));
    expect(await queue.steer("hi")).toEqual({ ok: false, reason: "the agent takes no steered messages" });
    expect(queue.list()).toEqual([]);
  });

  it("is steered once the agent takes the message and says so", async () => {
    const dir = inbox();
    const queue = new MessageQueue(dir, { offerWaitMs: 2000 });
    const steered: string[] = [];
    queue.onSteered((message, state) => steered.push(`${message.text}:${state}`));
    const pending = queue.steer("look at the tests first");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [item] = queue.list();
    expect(item.state).toBe("offered");
    renameSync(join(dir, `${item.id}.msg`), join(dir, `${item.id}.taken`));
    writeFileSync(join(dir, `${item.id}.ack.json`), JSON.stringify({ state: "steered" }));
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: true, state: "steered" });
    expect(queue.list()).toEqual([]);
    expect(steered).toEqual(["look at the tests first:steered"]);
  });

  it("queues an offered message the agent did not take before the turn ended", async () => {
    const dir = inbox();
    const queue = new MessageQueue(dir, { offerWaitMs: 50 });
    const outcome = await queue.steer("also update the docs");
    expect(outcome).toMatchObject({ ok: true, state: "offered" });
    queue.turnEnded();
    queue.close();
    const [item] = queue.list();
    expect(item).toMatchObject({ text: "also update the docs", state: "queued" });
    expect(existsSync(join(dir, `${item.id}.withdrawn`))).toBe(true);
    expect(queue.edit(item.id, "also update the README")?.text).toBe("also update the README");
  });
});
