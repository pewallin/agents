import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  claudeSourceFromCLIOutput,
  codexRPCArguments,
  codexSourceFromRPCSnapshot,
  copilotSourceFromAPIResponse,
  discoverUsageProviders,
  fetchAgentUsageSnapshot,
  kiroSourceFromCLIOutput,
} from "./usage.js";

describe("usage provider discovery", () => {
  it("uses enabled CodexBar providers without exposing provider secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-usage-config-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: [
          { id: "codex", enabled: true },
          { id: "copilot", enabled: true, apiKey: "secret-token" },
          { id: "opencode", enabled: false },
          { id: "unknown", enabled: true },
        ],
      }));

      expect(discoverUsageProviders({
        CODEXBAR_CONFIG_PATH: configPath,
        AGENTS_CODEX_BIN: "/missing/codex",
        AGENTS_CLAUDE_BIN: "/missing/claude",
        AGENTS_KIRO_BIN: "/missing/kiro-cli",
      })).toEqual([
        { id: "codex", enabled: true },
        { id: "copilot", enabled: true, apiKey: "secret-token" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors AGENTS_USAGE_PROVIDERS for deterministic command runs", () => {
    expect(discoverUsageProviders({ AGENTS_USAGE_PROVIDERS: "codex, claude" }).map((provider) => provider.id))
      .toEqual(["codex", "claude"]);
  });

  it("discovers installed CLI quota providers independently of CodexBar toggles", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-usage-discovery-"));
    try {
      const kiroPath = join(dir, "kiro-cli");
      const configPath = join(dir, "config.json");
      writeFileSync(kiroPath, "#!/bin/sh\nexit 0\n");
      writeFileSync(configPath, JSON.stringify({ providers: [{ id: "kiro", enabled: false }] }));
      chmodSync(kiroPath, 0o755);

      expect(discoverUsageProviders({
        CODEXBAR_CONFIG_PATH: configPath,
        AGENTS_CODEX_BIN: "/missing/codex",
        AGENTS_CLAUDE_BIN: "/missing/claude",
        AGENTS_KIRO_BIN: kiroPath,
      })).toEqual([{ id: "kiro", enabled: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex usage mapping", () => {
  it("launches the app server with Codex's current non-interactive approval policy", () => {
    expect(codexRPCArguments()).toEqual(["-s", "read-only", "-a", "never", "app-server"]);
  });

  it("maps Codex RPC primary and secondary windows to session and week quota rows", () => {
    const source = codexSourceFromRPCSnapshot({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1_700_100_000 },
        planType: "pro",
      },
      account: { account: { type: "chatgpt", email: "user@example.com", planType: "pro" } },
    });

    expect(source.status).toBe("available");
    expect(source.provider).toBe("codex");
    expect(source.providerLabel).toBe("Codex");
    expect(source.account).toEqual({ id: "user@example.com", label: "user@example.com" });
    expect(source.windows[0]).toMatchObject({
      kind: "session",
      label: "Session",
      status: "available",
      used: 42,
      limit: 100,
      remaining: 58,
      unit: "percent",
      resetsAt: "2023-11-14T22:13:20Z",
      source: "codex-cli",
    });
    expect(source.windows[1]).toMatchObject({
      kind: "week",
      status: "available",
      used: 61,
      limit: 100,
      remaining: 39,
    });
    expect(source.windows.map((window) => window.kind)).toEqual(["session", "week"]);
  });

  it("keeps missing Codex windows absent instead of treating them as zero", () => {
    const source = codexSourceFromRPCSnapshot({
      rateLimits: {
        planType: "free",
      },
      account: { account: { type: "chatgpt", email: "user@example.com", planType: "free" } },
    });

    expect(source.status).toBe("unavailable");
    expect(source.windows).toEqual([]);
  });
});

describe("Claude usage mapping", () => {
  it("maps current direct CLI session and weekly usage", () => {
    const source = claudeSourceFromCLIOutput(`
You are currently using your subscription to power your Claude Code usage

Current session: 23% used
Current week (all models): 61% used
`);

    expect(source).toMatchObject({
      provider: "claude",
      providerLabel: "Claude",
      status: "available",
      source: "claude-cli",
    });
    expect(source.windows).toEqual([
      expect.objectContaining({
        kind: "session",
        label: "Session",
        used: 23,
        limit: 100,
        remaining: 77,
        unit: "percent",
      }),
      expect.objectContaining({
        kind: "week",
        label: "Week",
        used: 61,
        limit: 100,
        remaining: 39,
        unit: "percent",
      }),
    ]);
  });

  it("normalizes legacy remaining percentages to used quota", () => {
    const source = claudeSourceFromCLIOutput(`
Current session: 75% left
Current week (all models): 40% remaining
`);

    expect(source.windows.map((window) => window.used)).toEqual([25, 60]);
  });
});

describe("Kiro usage mapping", () => {
  it("maps current Kiro plan credits and reset date", () => {
    const source = kiroSourceFromCLIOutput(`
Estimated Usage | resets on 2026-09-01 | KIRO FREE
Credits (12.50 of 50 covered in plan)
████ 25.0%
`, new Date("2026-08-26T12:00:00Z"));

    expect(source).toMatchObject({
      provider: "kiro",
      providerLabel: "Kiro",
      account: { id: "KIRO FREE", label: "KIRO FREE" },
      status: "available",
      source: "kiro-cli",
    });
    expect(source.windows).toEqual([
      expect.objectContaining({
        kind: "month",
        label: "Monthly credits",
        used: 12.5,
        limit: 50,
        remaining: 37.5,
        unit: "credits",
        resetsAt: "2026-09-01T00:00:00Z",
      }),
    ]);
  });

  it("keeps bonus credits as a separate window", () => {
    const source = kiroSourceFromCLIOutput(`
| KIRO PRO
Monthly credits:
(40 of 100 covered in plan)
Bonus credits: 5/20 credits used, expires in 10 days
`, new Date("2026-08-26T12:00:00Z"));

    expect(source.windows).toEqual([
      expect.objectContaining({ kind: "month", used: 40, limit: 100, remaining: 60 }),
      expect.objectContaining({ kind: "bonus-credits", used: 5, limit: 20, remaining: 15 }),
    ]);
  });
});

describe("Copilot usage mapping", () => {
  it("maps Copilot quota to a request row without session week or month windows", () => {
    const source = copilotSourceFromAPIResponse(
      {
        copilot_plan: "business",
        quota_reset_date: "2026-06-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 1000,
            remaining: 250,
            percent_remaining: 25,
            quota_id: "premium_interactions",
          },
        },
      },
      { id: "1234", label: "octocat" },
    );

    expect(source.status).toBe("available");
    expect(source.account).toEqual({ id: "1234", label: "octocat" });
    expect(source.windows).toHaveLength(1);
    expect(source.windows[0]).toMatchObject({
      kind: "requests",
      label: "Requests",
      status: "available",
      used: 750,
      limit: 1000,
      remaining: 250,
      unit: "requests",
      resetsAt: "2026-06-01T00:00:00Z",
      source: "api",
    });
  });

  it("falls back to monthly quota fields only when denominator and remaining are real", () => {
    const source = copilotSourceFromAPIResponse({
      copilot_plan: "individual",
      monthly_quotas: { chat: 300 },
      limited_user_quotas: { chat: 120 },
    });

    expect(source.status).toBe("available");
    expect(source.account).toBeUndefined();
    expect(source.windows[0]).toMatchObject({
      used: 180,
      limit: 300,
      remaining: 120,
    });
  });

  it("keeps token-based billing placeholders unavailable instead of showing fake zero usage", () => {
    const source = copilotSourceFromAPIResponse({
      copilot_plan: "business",
      token_based_billing: true,
      monthly_quotas: { completions: 300 },
      limited_user_quotas: { completions: 120 },
      quota_snapshots: {
        premium_interactions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "premium_interactions",
        },
        chat: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "chat",
        },
      },
    });

    expect(source.status).toBe("unavailable");
    expect(source.windows).toEqual([]);
    expect(source.source).toBe("api");
    expect(source.errorMessage).toContain("pooled AI credit billing");
    expect(source.errorMessage).toContain("Copilot business");
  });

  it("maps a finite token-based billing snapshot to AI credits", () => {
    const source = copilotSourceFromAPIResponse({
      copilot_plan: "business",
      token_based_billing: true,
      quota_reset_date: "2026-08-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 15000,
          remaining: 11001,
          percent_remaining: 73.3,
          quota_id: "premium_interactions",
        },
      },
    });

    expect(source.status).toBe("available");
    expect(source.windows).toHaveLength(1);
    expect(source.windows[0]).toMatchObject({
      kind: "credits",
      label: "AI Credits",
      status: "available",
      used: 3999,
      limit: 15000,
      remaining: 11001,
      unit: "credits",
      resetsAt: "2026-08-01T00:00:00Z",
      source: "api",
    });
  });

  it("keeps explicitly unlimited token-based billing snapshots unavailable", () => {
    const source = copilotSourceFromAPIResponse({
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 15000,
          remaining: 11001,
          percent_remaining: 73.3,
          quota_id: "premium_interactions",
          unlimited: true,
        },
      },
    });

    expect(source.status).toBe("unavailable");
    expect(source.windows).toEqual([]);
    expect(source.errorMessage).toContain("no usable AI credit quota");
  });

  it("uses renamed premium-like snapshot quota keys", () => {
    const source = copilotSourceFromAPIResponse({
      quota_snapshots: {
        premium_requests: {
          entitlement: "500",
          remaining: "125",
          percent_remaining: "25",
          quota_id: "premium_requests",
        },
      },
    });

    expect(source.status).toBe("available");
    expect(source.windows[0]).toMatchObject({
      used: 375,
      limit: 500,
      remaining: 125,
    });
  });

  it("falls back to the first usable snapshot quota when GitHub sends an unknown key", () => {
    const source = copilotSourceFromAPIResponse({
      quota_snapshots: {
        mystery_bucket: {
          entitlement: 80,
          remaining: 30,
          quota_id: "mystery_bucket",
        },
      },
    });

    expect(source.status).toBe("available");
    expect(source.windows[0]).toMatchObject({
      used: 50,
      limit: 80,
      remaining: 30,
    });
  });
});

describe("usage snapshot", () => {
  it("runs the Claude CLI collector through the normalized snapshot contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-usage-claude-"));
    const claudePath = join(dir, "claude");
    writeFileSync(claudePath, `#!/bin/sh
test "$1" = "/usage" || exit 2
printf 'Current session: 10%% used\\nCurrent week (all models): 20%% used\\n'
`);
    chmodSync(claudePath, 0o755);

    const now = new Date("2026-05-27T09:00:00Z");
    try {
      const snapshot = await fetchAgentUsageSnapshot({
        now,
        env: { AGENTS_CLAUDE_BIN: claudePath },
        providers: [{ id: "claude", enabled: true }],
      });

      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.generatedAt).toBe("2026-05-27T09:00:00Z");
      expect(snapshot.sources).toHaveLength(1);
      expect(snapshot.sources[0]).toMatchObject({
        provider: "claude",
        providerLabel: "Claude",
        status: "available",
        source: "claude-cli",
      });
      expect(snapshot.sources[0].windows.map((window) => window.used)).toEqual([10, 20]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the Kiro CLI collector with the non-interactive usage command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-usage-kiro-"));
    const kiroPath = join(dir, "kiro-cli");
    writeFileSync(kiroPath, `#!/bin/sh
test "$1 $2 $3" = "chat --no-interactive /usage" || exit 2
printf 'Estimated Usage | resets on 2026-09-01 | KIRO FREE\\nCredits (5 of 50 covered in plan)\\n'
`);
    chmodSync(kiroPath, 0o755);

    try {
      const snapshot = await fetchAgentUsageSnapshot({
        now: new Date("2026-08-26T12:00:00Z"),
        env: { AGENTS_KIRO_BIN: kiroPath },
        providers: [{ id: "kiro", enabled: true }],
      });

      expect(snapshot.sources[0]).toMatchObject({
        provider: "kiro",
        status: "available",
        source: "kiro-cli",
      });
      expect(snapshot.sources[0].windows).toEqual([
        expect.objectContaining({ kind: "month", used: 5, limit: 50, remaining: 45 }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts providers with real usage data before unavailable providers", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const snapshot = await fetchAgentUsageSnapshot({
      now,
      providers: [{ id: "claude", enabled: true }, { id: "codex", enabled: true }],
      fetchers: {
        claude: async () => ({
          provider: "claude",
          providerLabel: "Claude",
          status: "unavailable",
          windows: [],
        }),
        codex: async () => ({
          provider: "codex",
          providerLabel: "Codex",
          status: "available",
          windows: [
            {
              kind: "session",
              label: "Session",
              status: "available",
              used: 25,
              limit: 100,
              remaining: 75,
              unit: "percent",
            },
          ],
        }),
      },
    });

    expect(snapshot.sources.map((source) => source.provider)).toEqual(["codex", "claude"]);
  });

  it("exposes a parseable CLI JSON command even when a provider collector errors", () => {
    const result = spawnSync(process.execPath, [
      "./node_modules/.bin/vite-node",
      "--script",
      "src/cli.ts",
      "usage",
      "--json",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTS_USAGE_PROVIDERS: "codex",
        AGENTS_CODEX_BIN: "/bin/false",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: number; sources: Array<{ provider: string; status: string }> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sources).toEqual([
      expect.objectContaining({ provider: "codex", status: "error" }),
    ]);
  });
});
