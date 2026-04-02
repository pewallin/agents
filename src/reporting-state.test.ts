import { describe, expect, it } from "vitest";

import {
  getAssistantStopReason,
  shouldSettleIdleAfterAgentEnd,
} from "../extensions/pi/dustbot-reporting";

describe("getAssistantStopReason", () => {
  it("returns known assistant stop reasons", () => {
    expect(getAssistantStopReason({ stopReason: "stop" })).toBe("stop");
    expect(getAssistantStopReason({ stopReason: "length" })).toBe("length");
    expect(getAssistantStopReason({ stopReason: "toolUse" })).toBe("toolUse");
  });

  it("ignores missing or unknown stop reasons", () => {
    expect(getAssistantStopReason({})).toBeUndefined();
    expect(getAssistantStopReason({ stopReason: "done" })).toBeUndefined();
  });
});

describe("shouldSettleIdleAfterAgentEnd", () => {
  it("treats final assistant completions as terminal", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: true,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(true);

    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: true,
        lastAssistantStopReason: "length",
      }),
    ).toBe(true);
  });

  it("ignores non-terminal tool-use completions", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: true,
        lastAssistantStopReason: "toolUse",
      }),
    ).toBe(false);
  });

  it("ignores agent_end while tools are still pending", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 1,
        hasPendingMessages: false,
        isIdle: true,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(false);
  });

  it("ignores spurious agent_end when no prompt is active", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: false,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: true,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(false);
  });

  it("ignores agent_end while follow-up work is queued", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: true,
        isIdle: true,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(false);
  });

  it("ignores agent_end while pi does not consider the session idle yet", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: false,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(false);
  });
});
