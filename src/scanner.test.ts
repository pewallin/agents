import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { codexStreamDisconnectStatus, detectAgentProcess, externalSessionIdFromProcessArgs, extractClaudeRenameTitleFromTranscript, extractLatestCodexOpEntriesFromLogLines, extractLatestCodexOpsFromLogLines, extractLatestCodexSessionTitlesFromIndexLines, extractLatestCodexStreamDisconnectEntriesFromLogLines, extractLatestCodexTokenUsageFromSessionLines, extractLatestCodexTokenUsageSampleFromSessionLines, getDetector, filterAgents, inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent, matchesHistoryPaneFilter, reconcileStaleCodexWorkingState, resolveAgentIntentTitle, shouldTreatCodexWorkingAsIdle } from "./scanner.js";
import { extractFirstCopilotUserMessageTitleFromEventLines, extractLatestClaudeConversationActivityAt, extractLatestCodexConversationActivityAt, extractLatestCodexReasoningEffortFromSessionLines, extractLatestCopilotConversationActivityAt, extractLatestOpenCodeConversationActivityAt, extractLatestPiConversationActivityAt, extractLatestPiThinkingLevelFromSessionLines, getHistoryResumeInfo, historyTitleMatchesPaneTitle, resolveCodexFallbackTitleFromHistory, resolveCopilotHistoryTitle, shortTitleForHistoryTitle } from "./scanner-history.js";
import { agentResumeInvocation, agentStatusRequiresForce, resolveResumeTarget } from "./resume.js";
import { clearStateExternalSessionId, getAgentStateEntry, reportState } from "./state.js";
import { getStateDir } from "./paths.js";
import type { AgentPane } from "./scanner.js";

describe("getDetector", () => {
  it("returns hook detector for claude", () => {
    const d = getDetector("claude");
    expect(d).toBeDefined();
  });

  it("returns hook detector for copilot", () => {
    const d = getDetector("copilot");
    expect(d).toBeDefined();
  });

  it("returns codex detector with generic fallback behavior", () => {
    const d = getDetector("codex");
    expect(d).toBeDefined();
    expect(d.isWorking("⠋ Working...", "", "%missing-codex")).toBe(true);
    expect(d.isApproval("Do you want to run this command? (Y/n)", "%missing-codex")).toBe(true);
    expect(d.isQuestion("Open Questions\n- Should this happen?\n› Summarize recent commits", "%missing-codex")).toBe(false);
  });

  it("returns hook-only detector for kiro", () => {
    const d = getDetector("kiro");
    expect(d).toBeDefined();
    expect(d.isWorking("⠋ Working...", "", "%missing-kiro")).toBe(false);
    expect(d.isApproval("Do you want to run this command? (Y/n)", "%missing-kiro")).toBe(false);
  });

  it("is case-insensitive", () => {
    const a = getDetector("Claude");
    const b = getDetector("claude");
    expect(a).toBe(b);
  });
});

// ── filterAgents tests ────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentPane> & { pane: string; tmuxPaneId: string }): AgentPane {
  return {
    paneId: "dustbot:0",
    title: "",
    agent: "pi",
    status: "idle",
    windowId: "dustbot:0",
    ...overrides,
  };
}

describe("detectAgentProcess", () => {
  it("detects codex from a node wrapper command", () => {
    expect(detectAgentProcess("node", "node /Users/peter/.nvm/versions/node/v22.20.0/bin/codex --full-auto")).toBe("codex");
  });

  it("detects codex from a truncated comm using full args", () => {
    expect(detectAgentProcess("/Users/peter/.nv", "/Users/peter/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/vendor/codex/codex --full-auto")).toBe("codex");
  });

  it("normalizes kiro cli process names", () => {
    expect(detectAgentProcess("kiro-cli", "kiro-cli chat --tui")).toBe("kiro");
    expect(detectAgentProcess("kiro-cli-chat", "kiro-cli-chat chat --tui")).toBe("kiro");
  });
});

describe("externalSessionIdFromProcessArgs", () => {
  it("reads codex resume targets even when launch flags precede resume", () => {
    expect(externalSessionIdFromProcessArgs(
      "codex",
      "node /Users/peter/.nvm/bin/codex --dangerously-bypass-approvals-and-sandbox resume thread-123",
    )).toBe("thread-123");
  });

  it("reads codex resume targets after resume options", () => {
    expect(externalSessionIdFromProcessArgs(
      "codex",
      "codex --dangerously-bypass-approvals-and-sandbox resume -c model_reasoning_effort=\"xhigh\" thread-123",
    )).toBe("thread-123");
  });

  it("ignores codex resume --last because it is not a stable session id", () => {
    expect(externalSessionIdFromProcessArgs(
      "codex",
      "codex resume --last --dangerously-bypass-approvals-and-sandbox",
    )).toBeUndefined();
  });

  it("reads opencode session targets", () => {
    expect(externalSessionIdFromProcessArgs(
      "opencode",
      "opencode --session opencode-123",
    )).toBe("opencode-123");
  });

  it("reads kiro resume-id targets", () => {
    expect(externalSessionIdFromProcessArgs(
      "kiro",
      "kiro-cli chat --resume-id kiro-123",
    )).toBe("kiro-123");
    expect(externalSessionIdFromProcessArgs(
      "kiro",
      "kiro-cli chat --resume-id=kiro-456",
    )).toBe("kiro-456");
  });
});

describe("inferModelFromContent", () => {
  it("extracts codex model from footer", () => {
    const content = [
      "• Done",
      "",
      "gpt-5.2-codex high · 69% left · ~/code/agents-app",
    ].join("\n");
    expect(inferModelFromContent("codex", content)).toBe("gpt-5.2-codex");
  });

  it("extracts codex model from the new footer format", () => {
    const content = [
      "› review these beads",
      "",
      "gpt-5.4 high fast · backlog-app · main · Context [█▉   ] · weekly 90% · 258K window · Fast on",
    ].join("\n");
    expect(inferModelFromContent("codex", content)).toBe("gpt-5.4");
  });

  it("extracts pi model from footer", () => {
    const content = [
      "~/code · 11 pkgs • ↻...  (sub) · 9.5%/400k · 1h18m",
      "(github-copilot) GPT-5.4",
    ].join("\n");
    expect(inferModelFromContent("pi", content)).toBe("GPT-5.4");
  });
});

describe("inferModelMetadataFromContent", () => {
  it("extracts codex structured model metadata from footer", () => {
    const content = [
      "• Done",
      "",
      "gpt-5.2-codex high · 69% left · ~/code/agents-app",
    ].join("\n");
    expect(inferModelMetadataFromContent("codex", content)).toEqual({
      modelId: "gpt-5.2-codex",
      modelSource: "inferred",
      model: "gpt-5.2-codex",
    });
  });

  it("extracts pi structured provider/model metadata from footer", () => {
    const content = [
      "~/code · 11 pkgs • ↻...  (sub) · 9.5%/400k · 1h18m",
      "(github-copilot) GPT-5.4",
    ].join("\n");
    expect(inferModelMetadataFromContent("pi", content)).toEqual({
      provider: "github-copilot",
      modelLabel: "GPT-5.4",
      modelSource: "inferred",
      model: "GPT-5.4",
    });
  });
});

describe("inferContextFromContent", () => {
  it("extracts pi context usage from footer", () => {
    const content = "~/code · 11 pkgs • ↻...  (sub) · 9.5%/400k · 1h18m\n(github-copilot) GPT-5.4";
    expect(inferContextFromContent("pi", content)).toEqual({
      contextTokens: 38000,
      contextMax: 400000,
    });
  });

  it("extracts claude context usage from footer", () => {
    const content = "❯ \n  ✓ Dustbot | code | Context: 7% | Opus 4.6 (1M context)";
    expect(inferContextFromContent("claude", content)).toEqual({
      contextTokens: 70000,
      contextMax: 1000000,
    });
  });

  it("does not infer codex context usage from footer text", () => {
    const content = "gpt-5.4 high fast · backlog-app · main · Context [█▉   ] · weekly 90% · 258K window · Fast on";
    expect(inferContextFromContent("codex", content)).toEqual({});
  });
});

describe("extractLatestCodexTokenUsageFromSessionLines", () => {
  it("reads the latest token_count event from the session log", () => {
    const usage = extractLatestCodexTokenUsageFromSessionLines([
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 54321 },
            model_context_window: 258400,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 50000, cached_input_tokens: 1000, output_tokens: 2000, reasoning_output_tokens: 300 },
            model_context_window: 512000,
          },
        },
      }),
    ]);

    expect(usage).toEqual({
      contextTokens: 53300,
      contextMax: 512000,
    });
  });
});

describe("extractLatestCodexTokenUsageSampleFromSessionLines", () => {
  it("includes the event timestamp for freshness checks", () => {
    const usage = extractLatestCodexTokenUsageSampleFromSessionLines([
      JSON.stringify({
        timestamp: "1970-01-01T00:01:40.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 54321 },
            model_context_window: 258400,
          },
        },
      }),
    ]);

    expect(usage).toEqual({
      contextTokens: 54321,
      contextMax: 258400,
      observedAt: 100,
    });
  });
});

describe("extractClaudeRenameTitleFromTranscript", () => {
  it("extracts the latest non-empty /rename title", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "local_command", content: "<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args></command-args>" }),
      JSON.stringify({ type: "system", subtype: "local_command", content: "<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>Computer Help</command-args>" }),
    ];
    expect(extractClaudeRenameTitleFromTranscript(lines)).toBe("Computer Help");
  });
});

describe("extractLatestCodexOpsFromLogLines", () => {
  it("tracks the latest codex op per thread", () => {
    const threadA = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const threadB = "019d4430-b34d-7150-bbed-087160df7b56";
    const lines = [
      `2026-03-31T14:00:35Z INFO session_loop{thread_id=${threadA}}:submission_dispatch{codex.op="user_input"}: start`,
      `2026-03-31T14:00:36Z INFO session_loop{thread_id=${threadB}}:submission_dispatch{codex.op="user_input"}: start`,
      `2026-03-31T14:00:37Z INFO session_loop{thread_id=${threadA}}:submission_dispatch{codex.op="exec_approval"}: start`,
    ];
    const latest = extractLatestCodexOpsFromLogLines(lines);
    expect(latest.get(threadA)).toBe("exec_approval");
    expect(latest.get(threadB)).toBe("user_input");
  });

  it("keeps interrupt timestamps for stale-working reconciliation", () => {
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const latest = extractLatestCodexOpEntriesFromLogLines([
      `2026-03-31T14:00:35.250000Z INFO session_loop{thread_id=${thread}}:submission_dispatch{codex.op="user_input"}: start`,
      `2026-03-31T14:00:39.500000Z INFO session_loop{thread_id=${thread}}:submission_dispatch{codex.op="interrupt"}: start`,
    ]);

    expect(latest.get(thread)).toEqual({
      op: "interrupt",
      at: Date.parse("2026-03-31T14:00:39.500000Z") / 1000,
    });
  });
});

describe("codex stream disconnect detection", () => {
  it("tracks the latest stream disconnect per thread", () => {
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const latest = extractLatestCodexStreamDisconnectEntriesFromLogLines([
      `2026-03-31T14:00:35.250000Z WARN session_loop{thread_id=${thread}}:turn{thread.id=${thread}}: codex_core::session::turn: stream disconnected - retrying sampling request (1/5 in 218ms)...`,
      `2026-03-31T14:00:39.500000Z WARN session_loop{thread_id=${thread}}:turn{thread.id=${thread}}: codex_core::session::turn: stream disconnected - retrying sampling request (2/5 in 379ms)...`,
    ]);

    expect(latest.get(thread)).toEqual({
      attempt: 2,
      maxAttempts: 5,
      at: Date.parse("2026-03-31T14:00:39.500000Z") / 1000,
    });
  });

  it("marks a codex pane stalled for a fresh stream disconnect on the current session", () => {
    const session = `%vitest-codex-stream-disconnect-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const disconnects = new Map([[thread, { attempt: 4, maxAttempts: 5, at: entry.ts + 10 }]]);

      expect(codexStreamDisconnectStatus(session, undefined, disconnects, entry.ts + 20)).toEqual({
        status: "stalled",
        detail: "stream disconnected 4/5",
      });
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("ignores stream disconnects from an earlier state generation", () => {
    const session = `%vitest-codex-old-stream-disconnect-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const disconnects = new Map([[thread, { attempt: 5, maxAttempts: 5, at: entry.ts - 10 }]]);

      expect(codexStreamDisconnectStatus(session, undefined, disconnects, entry.ts + 20)).toBeUndefined();
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("expires stale stream disconnect warnings", () => {
    const session = `%vitest-codex-expired-stream-disconnect-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const disconnects = new Map([[thread, { attempt: 5, maxAttempts: 5, at: entry.ts + 10 }]]);

      expect(codexStreamDisconnectStatus(session, undefined, disconnects, entry.ts + 191)).toBeUndefined();
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });
});

describe("extractLatestCodexSessionTitlesFromIndexLines", () => {
  it("keeps the latest thread_name per session id", () => {
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const latest = extractLatestCodexSessionTitlesFromIndexLines([
      JSON.stringify({ id: thread, thread_name: "Agents App Roadmap" }),
      JSON.stringify({ id: thread, thread_name: "Agents App dev" }),
      "{bad json",
      JSON.stringify({ id: thread, thread_name: "Agents dev" }),
    ]);
    expect(latest.get(thread)).toBe("Agents dev");
  });
});

describe("resolveCodexFallbackTitleFromHistory", () => {
  it("uses a recent short Codex history title when the pane title is only the repo basename", () => {
    expect(
      resolveCodexFallbackTitleFromHistory("agents", "/Users/peter/code/agents", [
        "ta bort mcp_agent_mail mcp-servern från codex",
        "agents",
      ]),
    ).toBe("ta bort mcp_agent_mail mcp-servern från codex");
  });

  it("ignores very long first-prompt style titles", () => {
    expect(
      resolveCodexFallbackTitleFromHistory("shape", "/Users/peter/code/shape", [
        "Build a complete redesign of the sidebar and keep all previous behavior while also making it work across multiple repos with a large amount of project context that should not be truncated poorly",
      ]),
    ).toBeUndefined();
  });

  it("keeps an already-meaningful fallback title", () => {
    expect(
      resolveCodexFallbackTitleFromHistory("Fix sidebar regrouping", "/Users/peter/code/agents-app", [
        "Some other recent task",
      ]),
    ).toBeUndefined();
  });
});

describe("resolveCopilotHistoryTitle", () => {
  it("uses Copilot summary when available", () => {
    expect(resolveCopilotHistoryTitle({ summary: "Fix inspector session history" })).toEqual({
      title: "Fix inspector session history",
      titleSource: "summary",
    });
  });

  it("uses the first user message when the summary is missing or just an id", () => {
    const eventLines = [
      JSON.stringify({ type: "session.start", data: {} }),
      JSON.stringify({
        type: "user.message",
        data: { content: "Make Copilot history titles readable" },
      }),
    ];

    expect(resolveCopilotHistoryTitle({
      summary: "01ffadf1-dccd-4d9d-b9d5-59dfab95ed79",
      branch: "feature/history",
    }, eventLines)).toEqual({
      title: "Make Copilot history titles readable",
      titleSource: "first_prompt",
    });
  });

  it("falls back to branch metadata instead of showing the session uuid", () => {
    expect(resolveCopilotHistoryTitle({
      cwd: "/Users/peter/code/agents-app",
      branch: "feature/session-history",
    })).toEqual({
      title: "feature/session-history",
      titleSource: "session_info",
    });
  });

  it("extracts text from nested Copilot user message content", () => {
    expect(extractFirstCopilotUserMessageTitleFromEventLines([
      JSON.stringify({
        type: "user.message",
        data: { content: [{ text: "Summarize session inventory" }] },
      }),
    ])).toBe("Summarize session inventory");
  });
});

describe("session history activity timestamps", () => {
  const seconds = (timestamp: string) => Math.round(Date.parse(timestamp) / 1000);

  it("ignores Claude resume bookkeeping after the latest conversation message", () => {
    const latestConversationAt = "2026-01-01T00:05:00.000Z";
    expect(extractLatestClaudeConversationActivityAt([
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T00:04:00.000Z",
        message: { role: "user", content: "Fix the inspector" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: latestConversationAt,
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }),
      JSON.stringify({
        type: "progress",
        timestamp: "2026-01-01T00:10:00.000Z",
        data: { hookEvent: "SessionStart", hookName: "SessionStart:resume" },
      }),
      JSON.stringify({
        type: "system",
        subtype: "local_command",
        timestamp: "2026-01-01T00:11:00.000Z",
        content: "<command-name>/resume</command-name>",
      }),
    ])).toBe(seconds(latestConversationAt));
  });

  it("ignores Claude tool results when deriving conversation activity", () => {
    const latestConversationAt = "2026-01-01T00:05:00.000Z";
    expect(extractLatestClaudeConversationActivityAt([
      JSON.stringify({
        type: "assistant",
        timestamp: latestConversationAt,
        message: { role: "assistant", content: [{ type: "text", text: "Running tests" }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T00:07:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
    ])).toBe(seconds(latestConversationAt));
  });

  it("ignores Codex bootstrap entries and token counts after the latest response", () => {
    const latestConversationAt = "2026-01-01T00:05:00.000Z";
    expect(extractLatestCodexConversationActivityAt([
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "thread-123" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:03:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix session history timestamps" }],
        },
      }),
      JSON.stringify({
        timestamp: latestConversationAt,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fixed" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:10:00.000Z",
        type: "event_msg",
        payload: { type: "token_count" },
      }),
    ])).toBe(seconds(latestConversationAt));
  });

  it("reads the latest Codex reasoning effort from turn context", () => {
    expect(extractLatestCodexReasoningEffortFromSessionLines([
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4", effort: "high" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:05:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4", effort: "xhigh" },
      }),
    ])).toBe("xhigh");
  });

  it("uses Pi user and assistant messages, not tool results", () => {
    const latestConversationAt = "2026-01-01T00:05:00.000Z";
    expect(extractLatestPiConversationActivityAt([
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:03:00.000Z",
        message: { role: "user", content: "Fix this" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: latestConversationAt,
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:10:00.000Z",
        message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      }),
    ])).toBe(seconds(latestConversationAt));
  });

  it("reads the latest Pi thinking level from session events", () => {
    expect(extractLatestPiThinkingLevelFromSessionLines([
      JSON.stringify({
        type: "thinking_level_change",
        thinkingLevel: "medium",
      }),
      JSON.stringify({
        type: "thinking_level_change",
        thinkingLevel: "high",
      }),
    ])).toBe("high");
  });

  it("uses Copilot user and assistant messages, not tool execution metadata", () => {
    const latestConversationAt = "2026-01-01T00:05:00.000Z";
    expect(extractLatestCopilotConversationActivityAt([
      JSON.stringify({
        type: "user.message",
        timestamp: "2026-01-01T00:03:00.000Z",
        data: { content: "Fix this" },
      }),
      JSON.stringify({
        type: "assistant.message",
        timestamp: latestConversationAt,
        data: { content: "Done" },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        timestamp: "2026-01-01T00:10:00.000Z",
        data: { success: true },
      }),
    ])).toBe(seconds(latestConversationAt));
  });

  it("uses OpenCode user and assistant message times, not unrelated row updates", () => {
    expect(extractLatestOpenCodeConversationActivityAt([
      {
        timeUpdated: 1770000010000,
        data: JSON.stringify({
          role: "user",
          time: { created: 1770000000000 },
        }),
      },
      {
        timeUpdated: 1770000040000,
        data: JSON.stringify({
          role: "assistant",
          time: { created: 1770000020000, completed: 1770000030000 },
        }),
      },
      {
        timeUpdated: 1770000050000,
        data: JSON.stringify({
          role: "tool",
          time: { created: 1770000050000 },
        }),
      },
    ])).toBe(1770000030);
  });
});

describe("getHistoryResumeInfo", () => {
  it("returns restart metadata for codex sessions", () => {
    expect(getHistoryResumeInfo("codex", { sessionId: "thread-123" })).toEqual({
      strategy: "restart",
      target: "thread-123",
      targetKind: "session-id",
      command: "codex resume thread-123",
      argv: ["codex", "resume", "thread-123"],
    });
  });

  it("returns codex reasoning effort in resume metadata when available", () => {
    expect(getHistoryResumeInfo("codex", { sessionId: "thread-123", reasoningEffort: "xhigh" })).toEqual({
      strategy: "restart",
      target: "thread-123",
      targetKind: "session-id",
      command: "codex resume -c 'model_reasoning_effort=\"xhigh\"' thread-123",
      argv: ["codex", "resume", "-c", "model_reasoning_effort=\"xhigh\"", "thread-123"],
    });
  });

  it("returns restart metadata for claude sessions", () => {
    expect(getHistoryResumeInfo("claude", { sessionId: "claude-123" })).toEqual({
      strategy: "restart",
      target: "claude-123",
      targetKind: "session-id",
      command: "claude --resume claude-123",
      argv: ["claude", "--resume", "claude-123"],
    });
  });

  it("returns restart metadata for copilot sessions", () => {
    expect(getHistoryResumeInfo("copilot", { sessionId: "copilot-123" })).toEqual({
      strategy: "restart",
      target: "copilot-123",
      targetKind: "session-id",
      command: "copilot --resume=copilot-123",
      argv: ["copilot", "--resume=copilot-123"],
    });
  });

  it("returns switch-in-place metadata for pi session files", () => {
    expect(getHistoryResumeInfo("pi", { sessionId: "pi-123", sessionPath: "/tmp/pi-session.jsonl" })).toEqual({
      strategy: "switch-in-place",
      target: "/tmp/pi-session.jsonl",
      targetKind: "session-path",
      command: "pi --session /tmp/pi-session.jsonl --yolo",
      argv: ["pi", "--session", "/tmp/pi-session.jsonl", "--yolo"],
    });
  });

  it("returns restart metadata for opencode sessions", () => {
    expect(getHistoryResumeInfo("opencode", { sessionId: "opencode-123" })).toEqual({
      strategy: "restart",
      target: "opencode-123",
      targetKind: "session-id",
      command: "opencode --session opencode-123",
      argv: ["opencode", "--session", "opencode-123"],
    });
  });

  it("returns restart metadata for kiro sessions", () => {
    expect(getHistoryResumeInfo("kiro", { sessionId: "kiro-123" })).toEqual({
      strategy: "restart",
      target: "kiro-123",
      targetKind: "session-id",
      command: "kiro-cli chat --tui --resume-id kiro-123",
      argv: ["kiro-cli", "chat", "--tui", "--resume-id", "kiro-123"],
    });
  });
});

describe("resume helpers", () => {
  it("requires force for every non-idle status", () => {
    expect(agentStatusRequiresForce("idle")).toBe(false);
    expect(agentStatusRequiresForce("working")).toBe(true);
    expect(agentStatusRequiresForce("attention")).toBe(true);
    expect(agentStatusRequiresForce("question")).toBe(true);
    expect(agentStatusRequiresForce("stalled")).toBe(true);
  });

  it("resolves explicit session paths before ids", () => {
    expect(resolveResumeTarget({ pane: "%1", session: "id", sessionPath: "/tmp/session.jsonl" })).toEqual({
      target: "/tmp/session.jsonl",
      targetKind: "session-path",
    });
  });

  it("resolves new session requests before persisted targets", () => {
    expect(resolveResumeTarget({ pane: "%1", newSession: true, session: "id" })).toEqual({
      target: "new-session",
      targetKind: "new-session",
    });
  });

  it("builds claude, codex, copilot, pi, opencode, and kiro resume invocations", () => {
    expect(agentResumeInvocation("claude", { target: "claude-123", targetKind: "session-id" })).toEqual({
      strategy: "restart",
      argv: ["claude", "--resume", "claude-123"],
    });
    expect(agentResumeInvocation("codex", { target: "thread-123", targetKind: "session-id" })).toEqual({
      strategy: "restart",
      argv: ["codex", "resume", "thread-123"],
    });
    expect(agentResumeInvocation("copilot", { target: "copilot-123", targetKind: "session-id" })).toEqual({
      strategy: "restart",
      argv: ["copilot", "--resume=copilot-123"],
    });
    expect(agentResumeInvocation("pi", { target: "/tmp/pi.jsonl", targetKind: "session-path" })).toEqual({
      strategy: "switch-in-place",
      argv: ["pi", "--session", "/tmp/pi.jsonl", "--yolo"],
    });
    expect(agentResumeInvocation("opencode", { target: "opencode-123", targetKind: "session-id" })).toEqual({
      strategy: "restart",
      argv: ["opencode", "--session", "opencode-123"],
    });
    expect(agentResumeInvocation("kiro", { target: "kiro-123", targetKind: "session-id" })).toEqual({
      strategy: "restart",
      argv: ["kiro-cli", "chat", "--tui", "--resume-id", "kiro-123"],
    });
  });

  it("builds new session invocations from the matching agent profile", () => {
    expect(agentResumeInvocation(
      "codex",
      { target: "new-session", targetKind: "new-session" },
      { profile: { command: "codex --dangerously-bypass-approvals-and-sandbox" } },
    )).toEqual({
      strategy: "restart",
      argv: ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    });
  });

  it("builds prompted new session invocations for supported agents", () => {
    expect(agentResumeInvocation(
      "codex",
      { target: "new-session", targetKind: "new-session" },
      {
        profile: { command: "codex --dangerously-bypass-approvals-and-sandbox" },
        prompt: "Review this item",
      },
    )).toEqual({
      strategy: "restart",
      argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "Review this item"],
    });

    expect(agentResumeInvocation(
      "copilot",
      { target: "new-session", targetKind: "new-session" },
      {
        profile: { command: "copilot --allow-all-tools" },
        prompt: "Review this item",
      },
    )).toEqual({
      strategy: "restart",
      argv: ["copilot", "--allow-all-tools", "-i", "Review this item"],
    });

    expect(agentResumeInvocation(
      "opencode",
      { target: "new-session", targetKind: "new-session" },
      {
        profile: { command: "opencode" },
        prompt: "Review this item",
      },
    )).toEqual({
      strategy: "restart",
      argv: ["opencode", "--prompt", "Review this item"],
    });

    expect(agentResumeInvocation(
      "kiro",
      { target: "new-session", targetKind: "new-session" },
      {
        profile: { command: "kiro-cli chat --tui --agent agents-reporting" },
        prompt: "Review this item",
      },
    )).toEqual({
      strategy: "restart",
      argv: ["kiro-cli", "chat", "--tui", "--agent", "agents-reporting", "Review this item"],
    });
  });

  it("carries matching profile args into resume invocations", () => {
    expect(agentResumeInvocation(
      "codex",
      { target: "thread-123", targetKind: "session-id" },
      { profile: { command: "codex --dangerously-bypass-approvals-and-sandbox" } },
    )).toEqual({
      strategy: "restart",
      argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "resume", "thread-123"],
    });

    expect(agentResumeInvocation(
      "claude",
      { target: "claude-123", targetKind: "session-id" },
      { profile: { command: "claude --dangerously-skip-permissions" } },
    )).toEqual({
      strategy: "restart",
      argv: ["claude", "--dangerously-skip-permissions", "--resume", "claude-123"],
    });

    expect(agentResumeInvocation(
      "copilot",
      { target: "copilot-123", targetKind: "session-id" },
      { profile: { command: "copilot --allow-all-tools" } },
    )).toEqual({
      strategy: "restart",
      argv: ["copilot", "--allow-all-tools", "--resume=copilot-123"],
    });

    expect(agentResumeInvocation(
      "kiro",
      { target: "kiro-123", targetKind: "session-id" },
      { profile: { command: "kiro-cli chat --tui --agent agents-reporting" } },
    )).toEqual({
      strategy: "restart",
      argv: ["kiro-cli", "chat", "--tui", "--agent", "agents-reporting", "--resume-id", "kiro-123"],
    });
  });

  it("carries Codex reasoning effort into resume invocations", () => {
    expect(agentResumeInvocation(
      "codex",
      { target: "thread-123", targetKind: "session-id" },
      { reasoningEffort: "xhigh" },
    )).toEqual({
      strategy: "restart",
      argv: ["codex", "resume", "-c", "model_reasoning_effort=\"xhigh\"", "thread-123"],
    });
  });

  it("does not duplicate profile args already required by resume", () => {
    expect(agentResumeInvocation(
      "pi",
      { target: "/tmp/pi.jsonl", targetKind: "session-path" },
      { profile: { command: "pi --yolo" } },
    )).toEqual({
      strategy: "switch-in-place",
      argv: ["pi", "--yolo", "--session", "/tmp/pi.jsonl"],
    });
  });

  it("ignores a profile for a different agent", () => {
    expect(agentResumeInvocation(
      "codex",
      { target: "thread-123", targetKind: "session-id" },
      { profile: { command: "claude --dangerously-skip-permissions" } },
    )).toEqual({
      strategy: "restart",
      argv: ["codex", "resume", "thread-123"],
    });
  });

  it("clears stale external session ids before starting a new session", () => {
    const session = `%vitest-new-session-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    try {
      reportState("codex", session, "idle", { externalSessionId: "thread-old" });
      expect(getAgentStateEntry("codex", session)?.externalSessionId).toBe("thread-old");

      clearStateExternalSessionId("codex", session);

      expect(getAgentStateEntry("codex", session)?.externalSessionId).toBeUndefined();
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });
});

describe("matchesHistoryPaneFilter", () => {
  const pane = makeAgent({
    pane: "agents:codex.0",
    paneId: "agents:2",
    tmuxPaneId: "%52",
    windowId: "agents:2",
  });

  it("matches tmux pane ids", () => {
    expect(matchesHistoryPaneFilter(pane, "%52")).toBe(true);
  });

  it("matches app-qualified tmux pane ids", () => {
    expect(matchesHistoryPaneFilter(pane, "local:%52")).toBe(true);
  });

  it("matches pane and window identifiers", () => {
    expect(matchesHistoryPaneFilter(pane, "agents:codex.0")).toBe(true);
    expect(matchesHistoryPaneFilter(pane, "agents:2")).toBe(true);
  });

  it("rejects unrelated identifiers", () => {
    expect(matchesHistoryPaneFilter(pane, "%99")).toBe(false);
  });
});

describe("shortTitleForHistoryTitle", () => {
  it("collapses whitespace", () => {
    expect(shortTitleForHistoryTitle("First line\n\n  second   line")).toBe("First line");
  });

  it("truncates long titles for compact UI", () => {
    const shortTitle = shortTitleForHistoryTitle("x".repeat(140));
    expect(shortTitle).toHaveLength(120);
    expect(shortTitle.endsWith("...")).toBe(true);
  });
});

describe("historyTitleMatchesPaneTitle", () => {
  it("matches exact stable titles", () => {
    expect(historyTitleMatchesPaneTitle("Agents Dev", "Agents Dev")).toBe(true);
  });

  it("matches pi pane titles that include the session title", () => {
    expect(historyTitleMatchesPaneTitle("Creating GitLab MR", "π - Creating GitLab MR - gateway-graphql")).toBe(true);
  });

  it("does not match unrelated titles", () => {
    expect(historyTitleMatchesPaneTitle("Shape Dev", "Agents Dev")).toBe(false);
  });
});

describe("resolveAgentIntentTitle", () => {
  it("keeps the live pane title when it differs from the stable display title", () => {
    expect(resolveAgentIntentTitle("Committing fo-usecase changes", "Weekly pricing cleanup")).toBe("Committing fo-usecase changes");
  });

  it("drops the intent when the live pane title matches the display title", () => {
    expect(resolveAgentIntentTitle("Weekly pricing cleanup", "Weekly pricing cleanup")).toBeUndefined();
  });

  it("strips spinner prefixes before comparing titles", () => {
    expect(resolveAgentIntentTitle("⠋ Weekly pricing cleanup", "Weekly pricing cleanup")).toBeUndefined();
  });

  it("drops repo-basename pane titles when a richer display title exists", () => {
    expect(
      resolveAgentIntentTitle("agents", "ta bort mcp_agent_mail mcp-servern från codex", "/Users/peter/code/agents"),
    ).toBeUndefined();
  });
});

describe("shouldTreatCodexWorkingAsIdle", () => {
  it("treats stale codex working state as idle when the pane shows a prompt", () => {
    const session = `%vitest-codex-stale-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working");
    try {
      const entry = JSON.parse(readFileSync(statePath, "utf8")) as { ts: number };
      writeFileSync(statePath, JSON.stringify({ ...entry, state: "working", ts: entry.ts - 180, agent: "codex", session }));
      expect(shouldTreatCodexWorkingAsIdle("› Implement {feature}\n", "agents-app", session)).toBe(true);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("keeps very fresh codex working state even if the old prompt is still visible", () => {
    const session = `%vitest-codex-fresh-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working");
    try {
      expect(shouldTreatCodexWorkingAsIdle("› Implement {feature}\n", "agents-app", session)).toBe(false);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("treats interrupted codex turns as idle as soon as the pane shows a prompt", () => {
    const session = `%vitest-codex-interrupt-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const codexOps = new Map([[thread, { op: "interrupt", at: entry.ts + 2 }]]);

      expect(shouldTreatCodexWorkingAsIdle("› Implement {feature}\n", "agents-app", session, undefined, codexOps)).toBe(true);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("ignores interrupt log entries older than the current working state", () => {
    const session = `%vitest-codex-old-interrupt-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const codexOps = new Map([[thread, { op: "interrupt", at: entry.ts - 10 }]]);

      expect(shouldTreatCodexWorkingAsIdle("› Implement {feature}\n", "agents-app", session, undefined, codexOps)).toBe(false);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("does not treat codex approval prompts as idle", () => {
    const session = `%vitest-codex-approval-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working");
    try {
      expect(
        shouldTreatCodexWorkingAsIdle(
          "Would you like to run the following command?\n\nPress enter to confirm or esc to cancel",
          "agents-app",
          session,
        ),
      ).toBe(false);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });
});

describe("codex hook-first detection", () => {
  it("keeps codex working when hook state says working even if a stale prompt is visible", () => {
    const session = `%vitest-codex-hook-first-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    reportState("codex", session, "working");
    try {
      const entry = JSON.parse(readFileSync(statePath, "utf8")) as { ts: number };
      writeFileSync(statePath, JSON.stringify({ ...entry, state: "working", ts: entry.ts - 180, agent: "codex", session }));
      const detector = getDetector("codex");
      expect(shouldTreatCodexWorkingAsIdle("› Implement {feature}\n", "agents-app", session)).toBe(true);
      expect(detector.isWorking("› Implement {feature}\n", "agents-app", session)).toBe(true);
      expect(detector.isIdle("› Implement {feature}\n", "agents-app", session)).toBe(false);
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("converts stale codex working to idle after two unchanged cleanup samples", () => {
    const session = `%vitest-codex-cleanup-${Date.now()}`;
    const statePath = join(getStateDir(), `codex-${session}.json`);
    const prompt = "› Implement {feature}\n";
    reportState("codex", session, "working");
    try {
      const initial = JSON.parse(readFileSync(statePath, "utf8")) as { ts: number };
      writeFileSync(statePath, JSON.stringify({ ...initial, state: "working", ts: initial.ts - 180, agent: "codex", session }));

      reconcileStaleCodexWorkingState(prompt, "agents-app", session);
      expect(getAgentStateEntry("codex", session)?.state).toBe("working");

      const withCleanup = JSON.parse(readFileSync(statePath, "utf8")) as {
        cleanup?: { observedAt?: number };
      };
      writeFileSync(statePath, JSON.stringify({
        ...withCleanup,
        cleanup: {
          ...withCleanup.cleanup,
          observedAt: (withCleanup.cleanup?.observedAt ?? Math.floor(Date.now() / 1000)) - 31,
        },
      }));

      reconcileStaleCodexWorkingState(prompt, "agents-app", session);
      expect(getAgentStateEntry("codex", session)?.state).toBe("idle");
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });

  it("converts interrupted codex working state to idle without waiting for cleanup samples", () => {
    const session = `%vitest-codex-interrupt-cleanup-${Date.now()}`;
    const thread = "019d4387-5c99-70d0-93a1-fb9196ffb067";
    const statePath = join(getStateDir(), `codex-${session}.json`);
    const prompt = "› Implement {feature}\n";
    reportState("codex", session, "working", { externalSessionId: thread });
    try {
      const entry = getAgentStateEntry("codex", session)!;
      const codexOps = new Map([[thread, { op: "interrupt", at: entry.ts + 2 }]]);

      reconcileStaleCodexWorkingState(prompt, "agents-app", session, undefined, codexOps);
      expect(getAgentStateEntry("codex", session)?.state).toBe("idle");
    } finally {
      try { unlinkSync(statePath); } catch {}
    }
  });
});

describe("filterAgents", () => {
  const selfPane = "%10";
  const selfWindow = "dustbot:0";

  const agents: AgentPane[] = [
    makeAgent({ pane: "dustbot:pi.0", tmuxPaneId: "%10", windowId: "dustbot:0" }), // self
    makeAgent({ pane: "dustbot:claude.0", tmuxPaneId: "%11", windowId: "dustbot:1" }),
    makeAgent({ pane: "belgium:pi.0", tmuxPaneId: "%20", windowId: "belgium:0" }),
    makeAgent({ pane: "belgium:copilot.1", tmuxPaneId: "%21", windowId: "belgium:1" }),
  ];

  it("removes self pane and agents in own window", () => {
    const result = filterAgents(agents, selfPane, selfWindow);
    // %10 is self, removed. %11 is in dustbot:1 (different window), kept.
    // Sorted by pane name: belgium:copilot, belgium:pi, dustbot:claude
    expect(result.map((a) => a.tmuxPaneId)).toEqual(["%21", "%20", "%11"]);
  });

  it("re-adds previewed agent with original name", () => {
    // %20 is previewed — it's been swapped into the dashboard window
    const agentsWithSwap = agents.map((a) =>
      a.tmuxPaneId === "%20" ? { ...a, windowId: "dustbot:0" } : a
    );
    const result = filterAgents(agentsWithSwap, selfPane, selfWindow, {
      agentTmuxId: "%20",
      splitPaneId: "%50",
      agentPane: "belgium:pi.0",
      agentPaneId: "belgium:0",
    });
    const found = result.find((a) => a.tmuxPaneId === "%20");
    expect(found).toBeDefined();
    expect(found!.pane).toBe("belgium:pi.0");
  });

  it("filters out placeholder panes from preview", () => {
    const withPlaceholder = [
      ...agents,
      makeAgent({ pane: "placeholder", tmuxPaneId: "%50", windowId: "belgium:0" }),
    ];
    const result = filterAgents(withPlaceholder, selfPane, selfWindow, {
      agentTmuxId: "%20",
      splitPaneId: "%50",
      agentPane: "belgium:pi.0",
      agentPaneId: "belgium:0",
    });
    expect(result.find((a) => a.tmuxPaneId === "%50")).toBeUndefined();
  });

  it("re-adds grid agents with original names", () => {
    const result = filterAgents(agents, selfPane, selfWindow, null, {
      agents: [
        { tmuxPaneId: "%20", pane: "belgium:pi.0", paneId: "belgium:0", windowId: "belgium:0" },
        { tmuxPaneId: "%21", pane: "belgium:copilot.1", paneId: "belgium:1", windowId: "belgium:1" },
      ],
      placeholderIds: ["%60", "%61"],
    });
    expect(result.find((a) => a.tmuxPaneId === "%20")?.pane).toBe("belgium:pi.0");
    expect(result.find((a) => a.tmuxPaneId === "%21")?.pane).toBe("belgium:copilot.1");
  });

  it("re-adds grid agents with original pane targets for enter-jump", () => {
    const swapped = agents.map((a) =>
      a.tmuxPaneId === "%20" ? { ...a, paneId: "dustbot:0", windowId: "dustbot:0" } : a
    );
    const result = filterAgents(swapped, selfPane, selfWindow, null, {
      agents: [
        { tmuxPaneId: "%20", pane: "belgium:pi.0", paneId: "belgium:0", windowId: "belgium:0" },
      ],
      placeholderIds: ["%60"],
    });
    const found = result.find((a) => a.tmuxPaneId === "%20");
    expect(found?.paneId).toBe("belgium:0");
    expect(found?.windowId).toBe("belgium:0");
  });

  it("results are sorted by pane name", () => {
    const result = filterAgents(agents, selfPane, selfWindow);
    const panes = result.map((a) => a.pane);
    expect(panes).toEqual([...panes].sort());
  });
});

describe("generic detector patterns", () => {
  // Get the generic detector via an unknown agent name
  const detector = getDetector("codex");

  describe("isApproval", () => {
    it("matches (Y/n) prompt", () => {
      expect(detector.isApproval("Do you want to proceed? (Y/n)")).toBe(true);
    });

    it("matches (y/N) prompt", () => {
      expect(detector.isApproval("Continue? (y/N)")).toBe(true);
    });

    it("matches copilot selection UI", () => {
      expect(detector.isApproval("↑↓ to select · Enter to confirm")).toBe(true);
    });

    it("matches copilot navigation UI", () => {
      expect(detector.isApproval("↑↓ to navigate · Enter to select")).toBe(true);
    });

    it("matches Allow this action", () => {
      expect(detector.isApproval("Allow this action")).toBe(true);
    });

    it("matches claude permission prompt", () => {
      expect(detector.isApproval("△ Permission required")).toBe(true);
    });

    it("matches claude Allow once/always/Reject", () => {
      expect(detector.isApproval("Allow once  Allow always  Reject")).toBe(true);
    });

    it("matches current codex approval prompt wording", () => {
      expect(detector.isApproval("Would you like to run the following command?\n\nPress enter to confirm or esc to cancel")).toBe(true);
    });

    it("does not match normal content", () => {
      expect(detector.isApproval("Hello world\nThis is some code")).toBe(false);
    });
  });

  describe("isWorking", () => {
    it("matches braille spinner in content", () => {
      expect(detector.isWorking("⠋ Loading...", "")).toBe(true);
    });

    it("matches spinner in title", () => {
      expect(detector.isWorking("", "⠋ Working")).toBe(true);
    });

    it("matches Working... keyword", () => {
      expect(detector.isWorking("Working...", "")).toBe(true);
    });

    it("matches Thinking... keyword", () => {
      expect(detector.isWorking("Thinking...", "")).toBe(true);
    });

    it("does not match idle content", () => {
      expect(detector.isWorking("❯ ", "terminal")).toBe(false);
    });
  });

  describe("isIdle", () => {
    it("matches shell prompt ❯", () => {
      expect(detector.isIdle("some output\n❯ ", "")).toBe(true);
    });

    it("matches shell prompt ›", () => {
      expect(detector.isIdle("some output\n› ", "")).toBe(true);
    });

    it("matches $ prompt", () => {
      expect(detector.isIdle("some output\n$ ", "")).toBe(true);
    });

    it("matches copilot tab agents prompt", () => {
      expect(detector.isIdle("some output\ntab agents  ctrl+p commands", "")).toBe(true);
    });

    it("does not match working content", () => {
      expect(detector.isIdle("⠋ Loading data from server", "")).toBe(false);
    });
  });
});
