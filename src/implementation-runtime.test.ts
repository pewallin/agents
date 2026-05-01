import { existsSync } from "fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./scanner.js", () => ({
  scan: () => [
    {
      cwd: "/tmp/agents-runtime-session",
      pane: "0:takeoff:test:1",
      tmuxPaneId: "%42",
      agent: "codex",
      status: "working",
    },
  ],
}));

const {
  AgentsRuntimeError,
  createImplementationCheckout,
  getImplementationCheckoutStatus,
  listImplementationTargets,
} = await import("./implementation-runtime.js");

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createCommittedRepo(): Promise<{ repoRoot: string; sandboxRoot: string }> {
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "agents-runtime-"));
  const repoRoot = path.join(sandboxRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Agents Tests"]);
  await runGit(repoRoot, ["config", "user.email", "agents@example.com"]);
  await writeFile(path.join(repoRoot, "README.md"), "# Agents runtime\n", "utf8");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-m", "init"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return { repoRoot, sandboxRoot };
}

async function writeRemoteTargetConfig(sandboxRoot: string): Promise<string> {
  const configPath = path.join(sandboxRoot, "remote-hosts.json");
  await writeFile(
    configPath,
    JSON.stringify([
      {
        displayName: "mac-mini",
        endpoint: { kind: "ssh", username: "peter", hostname: "mac-mini", port: 22 },
        isEnabled: true,
        repoRoots: [path.join(sandboxRoot, "remote-code")],
      },
    ]),
    "utf8",
  );
  return configPath;
}

async function stubSsh(sandboxRoot: string, scriptBody: string): Promise<void> {
  const binDir = path.join(sandboxRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const sshPath = path.join(binDir, "ssh");
  await writeFile(sshPath, `#!/bin/bash\n${scriptBody}\n`, "utf8");
  await chmod(sshPath, 0o755);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("implementation runtime targets", () => {
  it("lists local plus enabled SSH targets from shared agents-app config", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "agents-targets-"));
    cleanupPaths.push(sandboxRoot);
    const configPath = path.join(sandboxRoot, "remote-hosts.json");
    await writeFile(
      configPath,
      JSON.stringify([
        {
          id: "host-1",
          displayName: "mac-mini",
          endpoint: { kind: "ssh", username: "peter", hostname: "mac-mini", port: 22 },
          isEnabled: true,
          repoRoots: ["~/dev"],
        },
        {
          displayName: "disabled",
          endpoint: { kind: "ssh", username: "peter", hostname: "disabled" },
          isEnabled: false,
        },
      ]),
      "utf8",
    );

    const result = listImplementationTargets({
      repoRoot: "/Users/peter/code/shape",
      homeDir: "/Users/peter",
      configPath,
    });

    expect(result.targets.map((target) => target.id)).toEqual(["local", "peter@mac-mini"]);
    expect(result.targets[1]?.repoRoots).toEqual(["/Users/peter/dev"]);
  });

  it("surfaces malformed shared target config as a structured runtime error", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "agents-targets-bad-"));
    cleanupPaths.push(sandboxRoot);
    const configPath = path.join(sandboxRoot, "remote-hosts.json");
    await writeFile(configPath, "{not json", "utf8");

    expect(() => listImplementationTargets({ configPath })).toThrow(AgentsRuntimeError);
    try {
      listImplementationTargets({ configPath });
    } catch (error) {
      expect(error).toMatchObject({
        phase: "read_target_config",
        code: "target_config_invalid_json",
      });
    }
  });
});

describe("implementation checkout runtime", () => {
  it("creates local implementation checkouts from a clean base ref even when the current checkout is dirty", async () => {
    const sandbox = await createCommittedRepo();
    cleanupPaths.push(sandbox.sandboxRoot);
    await runGit(sandbox.repoRoot, ["checkout", "-b", "feature/in-progress"]);
    await writeFile(path.join(sandbox.repoRoot, "FEATURE.md"), "feature only\n", "utf8");
    await runGit(sandbox.repoRoot, ["add", "FEATURE.md"]);
    await runGit(sandbox.repoRoot, ["commit", "-m", "feature"]);
    await writeFile(path.join(sandbox.repoRoot, "dirty.txt"), "dirty\n", "utf8");

    const result = createImplementationCheckout({
      sourceRepoPath: sandbox.repoRoot,
      name: "Add managed sessions",
      targetId: "local",
      baseRef: "main",
    });

    expect(result.executionCheckout.path).toContain(path.join(".shape-worktrees", "repo"));
    expect(await runGit(result.executionCheckout.path, ["branch", "--show-current"])).toBe(result.branch);
    await expect(runGit(result.executionCheckout.path, ["cat-file", "-e", "HEAD:FEATURE.md"])).rejects.toThrow();
    await expect(runGit(result.executionCheckout.path, ["cat-file", "-e", "HEAD:dirty.txt"])).rejects.toThrow();
  });

  it("reports checkout status with branch, head, ahead/behind, dirty state, and sessions", async () => {
    const sandbox = await createCommittedRepo();
    cleanupPaths.push(sandbox.sandboxRoot);
    const result = createImplementationCheckout({
      sourceRepoPath: sandbox.repoRoot,
      name: "Status contract",
      targetId: "local",
      baseRef: "main",
    });
    await writeFile(path.join(result.executionCheckout.path, "CHANGE.md"), "change\n", "utf8");
    await runGit(result.executionCheckout.path, ["add", "CHANGE.md"]);
    await runGit(result.executionCheckout.path, ["commit", "-m", "change"]);
    await writeFile(path.join(result.executionCheckout.path, "dirty.txt"), "dirty\n", "utf8");

    const status = getImplementationCheckoutStatus({
      targetId: "local",
      path: result.executionCheckout.path,
      checkoutId: result.executionCheckout.checkoutId,
      baseRef: "main",
      repoName: result.repoName,
    });

    expect(status.checkouts[0]).toEqual(expect.objectContaining({
      checkoutId: result.executionCheckout.checkoutId,
      branch: result.branch,
      ahead: 1,
      behind: 0,
      dirty: true,
      merged: false,
    }));
    expect(status.checkouts[0]?.headSha).toMatch(/[a-f0-9]{40}/);
  });

  it("discovers implementation checkouts for a repo when no checkout path is provided", async () => {
    const sandbox = await createCommittedRepo();
    cleanupPaths.push(sandbox.sandboxRoot);
    const first = createImplementationCheckout({
      sourceRepoPath: sandbox.repoRoot,
      name: "First status listing",
      targetId: "local",
      baseRef: "main",
    });
    const second = createImplementationCheckout({
      sourceRepoPath: sandbox.repoRoot,
      name: "Second status listing",
      targetId: "local",
      baseRef: "main",
    });
    await writeFile(path.join(second.executionCheckout.path, "CHANGE.md"), "change\n", "utf8");
    await runGit(second.executionCheckout.path, ["add", "CHANGE.md"]);
    await runGit(second.executionCheckout.path, ["commit", "-m", "change"]);

    const status = getImplementationCheckoutStatus({
      targetId: "local",
      repoRoot: sandbox.repoRoot,
      repoName: first.repoName,
    });

    expect(status.checkouts.map((checkout) => checkout.checkoutId).sort()).toEqual([
      first.executionCheckout.checkoutId,
      second.executionCheckout.checkoutId,
    ].sort());
    expect(status.checkouts.map((checkout) => checkout.path)).not.toContain(sandbox.repoRoot);
    expect(status.checkouts.find((checkout) => checkout.checkoutId === second.executionCheckout.checkoutId)).toEqual(expect.objectContaining({
      branch: second.branch,
      ahead: 1,
      behind: 0,
      merged: false,
      dirty: false,
    }));
  });

  it("checks remote agents compatibility before creating a local landing checkout", async () => {
    const sandbox = await createCommittedRepo();
    cleanupPaths.push(sandbox.sandboxRoot);
    const configPath = await writeRemoteTargetConfig(sandbox.sandboxRoot);
    await stubSsh(sandbox.sandboxRoot, 'echo "agents missing" >&2\nexit 127');

    expect(() =>
      createImplementationCheckout({
        sourceRepoPath: sandbox.repoRoot,
        name: "Remote runtime order",
        targetId: "peter@mac-mini",
        baseRef: "main",
        configPath,
        cloneIfMissing: true,
        localLanding: true,
      }),
    ).toThrow(AgentsRuntimeError);

    try {
      createImplementationCheckout({
        sourceRepoPath: sandbox.repoRoot,
        name: "Remote runtime order",
        targetId: "peter@mac-mini",
        baseRef: "main",
        configPath,
        cloneIfMissing: true,
        localLanding: true,
      });
    } catch (error) {
      expect(error).toMatchObject({
        phase: "check_remote_runtime",
        code: "remote_agents_unavailable",
      });
    }

    expect(existsSync(path.join(sandbox.sandboxRoot, ".shape-worktrees", "repo", "remote-runtime-order"))).toBe(false);
  });

  it("preserves structured remote agents failures from stderr", async () => {
    const sandbox = await createCommittedRepo();
    cleanupPaths.push(sandbox.sandboxRoot);
    const configPath = await writeRemoteTargetConfig(sandbox.sandboxRoot);
    await stubSsh(
      sandbox.sandboxRoot,
      [
        'cmd="${@: -1}"',
        'if [[ "$cmd" == *"command -v agents"* ]]; then exit 0; fi',
        'if [[ "$cmd" == *"agents checkout status"* ]]; then',
        '  echo \'{"ok":false,"phase":"refresh_status","code":"status_repo_missing","message":"Remote checkout path is missing.","targetId":"local","retryable":true,"details":{"path":"/missing"}}\' >&2',
        "  exit 42",
        "fi",
        "exit 1",
      ].join("\n"),
    );

    expect(() =>
      getImplementationCheckoutStatus({
        targetId: "peter@mac-mini",
        repoRoot: sandbox.repoRoot,
        repoName: "repo",
        configPath,
      }),
    ).toThrow(AgentsRuntimeError);

    try {
      getImplementationCheckoutStatus({
        targetId: "peter@mac-mini",
        repoRoot: sandbox.repoRoot,
        repoName: "repo",
        configPath,
      });
    } catch (error) {
      expect(error).toMatchObject({
        phase: "refresh_status",
        code: "status_repo_missing",
        message: "Remote checkout path is missing.",
        targetId: "peter@mac-mini",
        retryable: true,
        details: {
          path: "/missing",
          remoteTargetId: "local",
          status: 42,
        },
      });
    }
  });
});
