import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  codexSourceFromRPCSnapshot,
  copilotSourceFromAPIResponse,
  discoverUsageProviders,
  fetchAgentUsageSnapshot,
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

      expect(discoverUsageProviders({ CODEXBAR_CONFIG_PATH: configPath })).toEqual([
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
});

describe("Codex usage mapping", () => {
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
  it("builds schemaVersion 1 snapshots and preserves provider-level unavailable states", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const snapshot = await fetchAgentUsageSnapshot({
      now,
      providers: [{ id: "claude", enabled: true }],
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generatedAt).toBe("2026-05-27T09:00:00Z");
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({
      provider: "claude",
      providerLabel: "Claude",
      status: "unavailable",
      source: "agents usage",
      errorMessage: "Claude quota collection is not implemented in agents yet.",
    });
    expect(snapshot.sources[0].windows).toEqual([]);
  });

  it("sorts providers with real usage data before unavailable providers", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const snapshot = await fetchAgentUsageSnapshot({
      now,
      providers: [{ id: "claude", enabled: true }, { id: "codex", enabled: true }],
      fetchers: {
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
