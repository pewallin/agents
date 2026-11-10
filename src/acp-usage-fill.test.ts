import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpUsageFill, filledUsageUpdate } from "./acp-usage-fill.js";
import type { StateUsage } from "./scanner-state-runtime.js";

const line = (message: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...message });
const usageOf = (sent: string) => JSON.parse(sent).params.update;

describe("AcpUsageFill", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("gives the view the session's usage when it opens and after each turn, read again a little later", async () => {
    vi.useFakeTimers();
    let usage: StateUsage = { contextTokens: 15_000, contextMax: 1_000_000, spend: 0.4, spendUnit: "credits" };
    const read = vi.fn((_sessionId: string) => usage);
    const sent: string[] = [];
    const fill = new AcpUsageFill(read, (text) => sent.push(text), 2_000);

    fill.clientLine(line({ id: 1, method: "session/new", params: { cwd: "/p" } }));
    fill.agentLine(line({ id: 1, result: { sessionId: "sess_1" } }));
    expect(sent).toHaveLength(0); // after the answer has gone to the view
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledWith("sess_1");
    expect(usageOf(sent[0])).toMatchObject({ sessionUpdate: "usage_update", used: 15_000, size: 1_000_000, cost: { amount: 0.4, currency: "credits" } });

    fill.clientLine(line({ id: 2, method: "session/prompt", params: { sessionId: "sess_1", prompt: [] } }));
    fill.agentLine(line({ id: 2, result: { stopReason: "end_turn" } }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1); // nothing new: not sent again

    fill.clientLine(line({ id: 3, method: "session/prompt", params: { sessionId: "sess_1", prompt: [] } }));
    fill.agentLine(line({ id: 3, result: { stopReason: "end_turn" } }));
    usage = { ...usage, spend: 0.7 };
    await vi.advanceTimersByTimeAsync(0);
    expect(usageOf(sent[1]).cost.amount).toBe(0.7);
    usage = { ...usage, contextTokens: 18_000 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(usageOf(sent[2]).used).toBe(18_000);
  });

  it("leaves an agent that reports its own usage to it", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const fill = new AcpUsageFill(() => ({ spend: 1, spendUnit: "credits" }), (text) => sent.push(text));
    fill.agentLine(line({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 10 } } }));
    fill.clientLine(line({ id: 1, method: "session/load", params: { sessionId: "s", cwd: "/p" } }));
    fill.agentLine(line({ id: 1, result: {} }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(0);
  });

  it("does not take its own update for the agent's", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const fill = new AcpUsageFill(() => ({ spend: 1, spendUnit: "credits" }), (text) => { sent.push(text); fill.agentLine(text); });
    fill.clientLine(line({ id: 1, method: "session/load", params: { sessionId: "s", cwd: "/p" } }));
    fill.agentLine(line({ id: 1, result: {} }));
    await vi.advanceTimersByTimeAsync(0);
    fill.clientLine(line({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } }));
    fill.agentLine(line({ id: 2, result: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(usageOf(sent[0])).toMatchObject({ used: 0, size: 0, cost: { amount: 1, currency: "credits" } });
  });

  it("sends nothing when nothing is known", () => {
    expect(filledUsageUpdate("s", {})).toBeUndefined();
    expect(filledUsageUpdate("s", { contextTokens: 5 })).toBeUndefined();
  });
});
