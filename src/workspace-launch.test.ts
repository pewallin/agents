import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn((command: string) => {
  if (command.startsWith("tmux new-window")) return "%42";
  if (command.includes("display-message -t %42 -p '#{session_name}'")) return "agents";
  return "";
});
const reportStateMock = vi.fn();
const writeFileSyncMock = vi.fn();
const randomUUIDMock = vi.fn(() => "fixed-uuid");

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
  };
});

vi.mock("crypto", () => ({
  randomUUID: randomUUIDMock,
}));

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

  it("appends override args to the resolved profile command", () => {
    const launch = resolveWorkspaceLaunch(undefined, undefined, undefined, {
      profile: "copilot",
      overrideArgs: ["--model", "gpt-5.4", "--resume"],
    });
    expect(launch.argv).toEqual(["copilot", "--yolo", "--model", "gpt-5.4", "--resume"]);
    expect(launch.agentCommand).toBe("copilot --yolo --model gpt-5.4 --resume");
    expect(launch.command).toBe("export OPENAI_API_KEY='abc 123'; export DEBUG_FLAG='enabled'; copilot --yolo --model gpt-5.4 --resume");
  });
});

describe("createWorkspace", () => {
  beforeEach(() => {
    writeFileSyncMock.mockClear();
    randomUUIDMock.mockClear();
    randomUUIDMock.mockReturnValue("fixed-uuid");
  });

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

  it("can launch the main tmux agent pane directly when requested", () => {
    createWorkspace(undefined, undefined, undefined, {
      profile: "bare",
      cwd: "/tmp/demo",
      agentOnly: true,
      directAgentLaunch: true,
    });

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/agents-launch-fixed-uuid.sh",
      expect.stringContaining("exec claude --dangerously-skip-permissions"),
      { mode: 0o755 },
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/agents-launch-fixed-uuid.sh",
      expect.stringContaining("export FEATURE_FLAG='1'"),
      { mode: 0o755 },
    );
    const expectedShell = process.env.SHELL || "/bin/sh";
    const newWindowCall = execMock.mock.calls.find(([command]) => String(command).startsWith("tmux new-window"));
    expect(newWindowCall?.[0]).toContain(JSON.stringify(`'${expectedShell}' -lc 'exec /tmp/agents-launch-fixed-uuid.sh'`));
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining(`tmux send-keys -t %42`));
  });
});
