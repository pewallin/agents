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
  it("treats agent_end as terminal for active prompts", () => {
    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: false,
        isIdle: false,
        lastAssistantStopReason: "stop",
      }),
    ).toBe(true);

    expect(
      shouldSettleIdleAfterAgentEnd({
        activePrompt: true,
        pendingToolExecutions: 0,
        hasPendingMessages: true,
        isIdle: false,
        lastAssistantStopReason: "toolUse",
      }),
    ).toBe(true);
  });

  it("keeps working if a tool is still pending", () => {
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
});
