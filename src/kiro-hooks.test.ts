import { execFileSync } from "child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kiro hooks", () => {
  it("reports a v3 UserPromptSubmit prompt as intent", () => {
    const directory = temporaryDirectory("agents-kiro-hook-test-");
    const stateDirectory = join(directory, "state");
    const scriptPath = fileURLToPath(new URL("../extensions/kiro/report-state.sh", import.meta.url));

    execFileSync("bash", [scriptPath], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "kiro-v3-session",
      }),
      env: {
        ...process.env,
        AGENTS_STATE_DIR: stateDirectory,
        AGENTS_RUNTIME_STATE_EVENTS_PATH: join(directory, "runtime-events.jsonl"),
        TMUX: "",
        TMUX_PANE: "%98",
        USER_PROMPT: "Ship Kiro v3 hooks",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const statePath = join(stateDirectory, readdirSync(stateDirectory)[0]);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.state).toBe("working");
    expect(state.intent).toBe("Ship Kiro v3 hooks");
    expect(state.externalSessionId).toBe("kiro-v3-session");
    expect(state.detail).toBeUndefined();
  });

  it("ignores v3 compatibility events emitted through the v2 agent hook", () => {
    const directory = temporaryDirectory("agents-kiro-v2-compat-test-");
    const stateDirectory = join(directory, "state");
    const scriptPath = fileURLToPath(new URL("../extensions/kiro/report-state.sh", import.meta.url));

    execFileSync("bash", [scriptPath], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "kiro-v3-session",
      }),
      env: {
        ...process.env,
        AGENTS_KIRO_V2_HOOK: "1",
        AGENTS_STATE_DIR: stateDirectory,
        AGENTS_RUNTIME_STATE_EVENTS_PATH: join(directory, "runtime-events.jsonl"),
        TMUX: "",
        TMUX_PANE: "%98",
        USER_PROMPT: "Do not report this duplicate",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    expect(() => readdirSync(stateDirectory)).toThrow();
  });

  it("installs and diagnoses both Kiro v2 and v3 hooks", async () => {
    const directory = temporaryDirectory("agents-kiro-setup-test-");
    const previousHome = process.env.HOME;
    const previousSetupHashPath = process.env.AGENTS_SETUP_HASH_PATH;
    process.env.HOME = directory;
    process.env.AGENTS_SETUP_HASH_PATH = join(directory, "setup-hash");
    // Kiro counts as installed when ~/.kiro exists; do not depend on kiro-cli on this machine.
    mkdirSync(join(directory, ".kiro"), { recursive: true });
    vi.resetModules();

    try {
      const { doctor, setup, uninstall } = await import("./setup.js");
      const setupResult = setup(true).find((result) => result.agent === "kiro");
      expect(setupResult?.action).toBe("installed");

      const v2ConfigPath = join(directory, ".kiro", "agents", "agents-reporting.json");
      const v3ConfigPath = join(directory, ".kiro", "hooks", "agents-reporting.json");
      const v2Config = JSON.parse(readFileSync(v2ConfigPath, "utf-8"));
      const v3Config = JSON.parse(readFileSync(v3ConfigPath, "utf-8"));

      expect(Object.keys(v2Config.hooks)).toEqual([
        "agentSpawn",
        "userPromptSubmit",
        "preToolUse",
        "postToolUse",
        "stop",
      ]);
      expect(v2Config.hooks.userPromptSubmit[0].command).toMatch(/^AGENTS_KIRO_V2_HOOK=1 /);
      expect(v3Config.version).toBe("v1");
      expect(v3Config.hooks.map((hook: { trigger: string }) => hook.trigger)).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
      ]);
      expect(doctor().find((result) => result.agent === "kiro")?.status).toBe("installed");

      unlinkSync(v3ConfigPath);
      const missingV3 = doctor().find((result) => result.agent === "kiro");
      expect(missingV3?.status).toBe("partial");
      expect(missingV3?.detail).toContain("~/.kiro/hooks/agents-reporting.json not found");

      setup(true);
      unlinkSync(v2ConfigPath);
      expect(uninstall().find((result) => result.agent === "kiro")?.action).toBe("uninstalled");
      expect(() => readFileSync(v2ConfigPath)).toThrow();
      expect(() => readFileSync(v3ConfigPath)).toThrow();
      const settings = JSON.parse(readFileSync(join(directory, ".kiro", "settings", "cli.json"), "utf-8"));
      expect(settings["chat.defaultAgent"]).toBeUndefined();
    } finally {
      restoreEnvironment("HOME", previousHome);
      restoreEnvironment("AGENTS_SETUP_HASH_PATH", previousSetupHashPath);
      vi.resetModules();
    }
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
