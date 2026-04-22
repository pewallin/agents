import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { detectAgentProcess, extractClaudeRenameTitleFromTranscript, extractLatestCodexOpsFromLogLines, extractLatestCodexSessionTitlesFromIndexLines, extractLatestCodexTokenUsageFromSessionLines, extractLatestCodexTokenUsageSampleFromSessionLines, getDetector, filterAgents, inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent, reconcileStaleCodexWorkingState, resolveAgentIntentTitle, shouldTreatCodexWorkingAsIdle } from "./scanner.js";
import { resolveCodexFallbackTitleFromHistory } from "./scanner-history.js";
import { getAgentStateEntry, reportState } from "./state.js";
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

describe("generic detector (screen-scraping)", () => {
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
