import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn((command: string) => {
  if (command.startsWith("tmux new-window")) return "%42";
  if (command.includes("display-message -t %42 -p '#{session_name}'")) return "agents";
  return "";
});
const reportStateMock = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: () => ({
    defaultCommand: "claude --dangerously-skip-permissions",
    defaultProfile: "copilot",
    profiles: {
      copilot: {
        command: "copilot --yolo",
        workspace: "small",
        name: "pair",
        env: {
          OPENAI_API_KEY: "abc 123",
          DEBUG_FLAG: "enabled",
        },
      },
      claude: {
        command: "claude --dangerously-skip-permissions",
        workspace: "default",
      },
      bare: {
        command: "claude --dangerously-skip-permissions",
        workspace: "default",
        env: {
          FEATURE_FLAG: "1",
        },
      },
    },
    helpers: {},
    workspace: {},
  }),
  resolveProfile: (profileName?: string) => {
    const profiles = {
      copilot: {
        command: "copilot --yolo",
        workspace: "small",
        name: "pair",
        env: {
          OPENAI_API_KEY: "abc 123",
          DEBUG_FLAG: "enabled",
        },
      },
      claude: {
        command: "claude --dangerously-skip-permissions",
        workspace: "default",
      },
      bare: {
        command: "claude --dangerously-skip-permissions",
        workspace: "default",
        env: {
          FEATURE_FLAG: "1",
        },
      },
    } as const;
    return profiles[(profileName || "copilot") as keyof typeof profiles] || profiles.copilot;
  },
}));

vi.mock("./shell.js", () => ({
  exec: execMock,
}));

vi.mock("./state.js", () => ({
  readStates: () => [],
  reportState: reportStateMock,
}));

vi.mock("./multiplexer.js", () => ({
  detectMultiplexer: () => "tmux",
  getMux: vi.fn(),
}));

const { createWorkspace, resolveWorkspaceLaunch } = await import("./workspace.js");

beforeEach(() => {
  execMock.mockClear();
  reportStateMock.mockClear();
});

describe("resolveWorkspaceLaunch", () => {
  it("uses the configured default profile when no profile is provided", () => {
    const launch = resolveWorkspaceLaunch(undefined, undefined, undefined, {});
    expect(launch.layout).toBe("small");
    expect(launch.name).toBe("pair");
    expect(launch.agentCommand).toBe("copilot --yolo");
    expect(launch.command).toContain("copilot --yolo");
  });

  it("applies profile environment variables before the command", () => {
    const launch = resolveWorkspaceLaunch(undefined, undefined, undefined, { profile: "copilot" });
    expect(launch.agentCommand).toBe("copilot --yolo");
    expect(launch.command).toBe("export OPENAI_API_KEY='abc 123'; export DEBUG_FLAG='enabled'; copilot --yolo");
  });

  it("preserves explicit override commands while still applying profile env", () => {
    const launch = resolveWorkspaceLaunch("copilot --resume", undefined, undefined, { profile: "copilot" });
    expect(launch.agentCommand).toBe("copilot --resume");
    expect(launch.command).toBe("export OPENAI_API_KEY='abc 123'; export DEBUG_FLAG='enabled'; copilot --resume");
  });

  it("does not apply the default profile to explicit commands without an explicit profile", () => {
    const launch = resolveWorkspaceLaunch("claude --resume", undefined, undefined, {});
    expect(launch.command).toBe("claude --resume");
    expect(launch.agentCommand).toBe("claude --resume");
    expect(launch.layout).toBeUndefined();
    expect(launch.name).toBeUndefined();
    expect(launch.profileEnv).toBeUndefined();
  });
});

describe("createWorkspace", () => {
  it("uses the underlying agent command for window naming and seeded state", () => {
    createWorkspace(undefined, undefined, undefined, { profile: "bare", cwd: "/tmp/demo", agentOnly: true });

    const renameCall = execMock.mock.calls.find(([command]) => String(command).includes("tmux rename-window -t %42"));
    expect(renameCall?.[0]).not.toContain(`"export:demo"`);
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining(`tmux send-keys -t %42 "export FEATURE_FLAG='1'; claude --dangerously-skip-permissions" Enter`));
    expect(reportStateMock).toHaveBeenCalledWith(
      "claude",
      "%42",
      "idle",
      undefined,
      expect.objectContaining({
        command: "export FEATURE_FLAG='1'; claude --dangerously-skip-permissions",
        cwd: "/tmp/demo",
        mux: "tmux",
        sessionName: "agents",
      }),
    );
  });
});
