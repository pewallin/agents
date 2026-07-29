import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";

export type AgentUsageAvailability = "available" | "unavailable" | "error";
export type AgentUsageWindowKind = "session" | "week" | "month" | string;
export type AgentUsageUnit = "requests" | "tokens" | "percent" | "credits" | string;

export interface AgentUsageHost {
  id: string;
  label: string;
}

export interface AgentUsageAccount {
  id?: string;
  label?: string;
}

export interface AgentUsageWindow {
  kind: AgentUsageWindowKind;
  label?: string;
  status?: AgentUsageAvailability;
  used?: number;
  limit?: number;
  remaining?: number;
  unit: AgentUsageUnit;
  resetsAt?: string;
  source?: string;
  errorMessage?: string;
}

export interface AgentUsageSource {
  host?: AgentUsageHost;
  provider: string;
  providerLabel?: string;
  account?: AgentUsageAccount;
  status: AgentUsageAvailability;
  windows: AgentUsageWindow[];
  source?: string;
  errorMessage?: string;
}

export interface AgentUsageSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  host?: AgentUsageHost;
  sources: AgentUsageSource[];
}

interface ProviderConfig {
  id: string;
  enabled?: boolean;
  apiKey?: string;
}

interface CodexBarConfig {
  providers?: ProviderConfig[];
}

interface UsageProviderDescriptor {
  id: string;
  label: string;
}

interface UsageBuildOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  providers?: ProviderConfig[];
  fetchers?: Partial<Record<string, UsageFetcherFunction>>;
}

type UsageFetcherFunction = (provider: ProviderConfig, env: NodeJS.ProcessEnv, now: Date) => Promise<AgentUsageSource>;

interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: unknown;
  planType?: string | null;
  plan_type?: string | null;
}

interface CodexAccountResponse {
  account?: {
    type?: string;
    email?: string;
    planType?: string;
    plan_type?: string;
  } | null;
}

interface CodexRPCSnapshot {
  rateLimits: CodexRateLimits;
  account?: CodexAccountResponse;
}

interface CopilotQuotaSnapshot {
  entitlement?: number | string;
  remaining?: number | string;
  percent_remaining?: number | string;
  quota_id?: string;
  unlimited?: boolean;
}

interface CopilotUsageResponse {
  quota_snapshots?: Record<string, CopilotQuotaSnapshot | undefined>;
  monthly_quotas?: {
    chat?: number | string;
    completions?: number | string;
  };
  limited_user_quotas?: {
    chat?: number | string;
    completions?: number | string;
  };
  copilot_plan?: string;
  token_based_billing?: boolean;
  quota_reset_date?: string;
}

interface CopilotUsableQuota {
  entitlement: number;
  remaining: number;
}

const SUPPORTED_PROVIDERS: Record<string, UsageProviderDescriptor> = {
  codex: { id: "codex", label: "Codex" },
  claude: { id: "claude", label: "Claude" },
  copilot: { id: "copilot", label: "Copilot" },
  pi: { id: "pi", label: "Pi" },
  opencode: { id: "opencode", label: "OpenCode" },
};

export async function fetchAgentUsageSnapshot(options: UsageBuildOptions = {}): Promise<AgentUsageSnapshot> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const providers = normalizeProviders(options.providers ?? discoverUsageProviders(env));
  const sources = await Promise.all(providers.map((provider) => fetchProviderUsage(provider, env, now, options.fetchers)));

  return {
    schemaVersion: 1,
    generatedAt: isoTimestamp(now),
    sources: sources.sort(compareUsageSources),
  };
}

export function discoverUsageProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const override = env.AGENTS_USAGE_PROVIDERS;
  if (override !== undefined) {
    return override
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, enabled: true }));
  }

  const codexBarProviders = readCodexBarProviders(env)
    .filter((provider) => provider.enabled !== false)
    .filter((provider) => SUPPORTED_PROVIDERS[provider.id]);

  if (codexBarProviders.length > 0) {
    return codexBarProviders;
  }

  return [{ id: "codex", enabled: true }];
}

function normalizeProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const seen = new Set<string>();
  const normalized: ProviderConfig[] = [];

  for (const provider of providers) {
    const id = provider.id.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ ...provider, id });
  }

  return normalized;
}

function readCodexBarProviders(env: NodeJS.ProcessEnv): ProviderConfig[] {
  const configPath = env.CODEXBAR_CONFIG_PATH || join(homedir(), ".codexbar", "config.json");
  if (!existsSync(configPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as CodexBarConfig;
    return Array.isArray(parsed.providers) ? parsed.providers : [];
  } catch {
    return [];
  }
}

async function fetchProviderUsage(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
  now: Date,
  fetchers?: UsageBuildOptions["fetchers"],
): Promise<AgentUsageSource> {
  const fetcher = fetchers?.[provider.id] ?? defaultFetcher(provider.id);
  if (!fetcher) {
    return unavailableSource(provider.id, "No real quota collector is available for this provider yet.");
  }

  try {
    return await fetcher(provider, env, now);
  } catch (error) {
    return errorSource(provider.id, errorMessage(error));
  }
}

function defaultFetcher(provider: string): UsageFetcherFunction | undefined {
  switch (provider) {
    case "codex":
      return fetchCodexUsage;
    case "copilot":
      return fetchCopilotUsage;
    case "claude":
      return async () => unavailableSource("claude", "Claude quota collection is not implemented in agents yet.");
    case "pi":
      return async () => unavailableSource("pi", "Pi quota collection is not implemented in agents yet.");
    case "opencode":
      return async () => unavailableSource("opencode", "OpenCode quota collection is not implemented in agents yet.");
    default:
      return undefined;
  }
}

async function fetchCodexUsage(_: ProviderConfig, env: NodeJS.ProcessEnv, now: Date): Promise<AgentUsageSource> {
  try {
    const snapshot = await fetchCodexRPCSnapshot(env);
    return codexSourceFromRPCSnapshot(snapshot, now);
  } catch (error) {
    const recovered = recoverCodexRateLimitsFromError(error);
    if (recovered) {
      return codexSourceFromRPCSnapshot({ rateLimits: recovered }, now);
    }
    throw error;
  }
}

export function codexSourceFromRPCSnapshot(snapshot: CodexRPCSnapshot, now: Date = new Date()): AgentUsageSource {
  const primary = codexWindow("session", "Session", snapshot.rateLimits.primary ?? undefined, "codex-cli");
  const secondary = codexWindow("week", "Week", snapshot.rateLimits.secondary ?? undefined, "codex-cli");
  const account = codexAccount(snapshot);
  const windows = [primary, secondary].filter((window): window is AgentUsageWindow => window !== undefined);
  const hasAvailableWindow = windows.some((window) => window.status !== "unavailable" && window.used !== undefined);

  return {
    provider: "codex",
    providerLabel: "Codex",
    ...(account ? { account } : {}),
    status: hasAvailableWindow ? "available" : "unavailable",
    windows,
    source: "codex-cli",
    ...(!hasAvailableWindow ? { errorMessage: "Codex CLI RPC returned account data but no quota windows." } : {}),
  };
}

async function fetchCopilotUsage(provider: ProviderConfig, env: NodeJS.ProcessEnv): Promise<AgentUsageSource> {
  const token = (env.COPILOT_API_TOKEN || provider.apiKey || "").trim();
  if (!token) {
    return unavailableSource("copilot", "No Copilot API token configured.");
  }

  const host = normalizeGitHubAPIHost(env.COPILOT_ENTERPRISE_HOST);
  const response = await fetch(`https://${host}/copilot_internal/user`, {
    headers: {
      "Accept": "application/json",
      "Authorization": `token ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Copilot API token was rejected.");
  }
  if (!response.ok) {
    throw new Error(`Copilot API returned HTTP ${response.status}.`);
  }

  const payload = await response.json() as CopilotUsageResponse;
  const account = await fetchCopilotAccount(token, host);
  return copilotSourceFromAPIResponse(payload, account);
}

export function copilotSourceFromAPIResponse(payload: CopilotUsageResponse, account?: AgentUsageAccount): AgentUsageSource {
  const usesCredits = payload.token_based_billing === true;
  const snapshotQuotas = usableCopilotSnapshotQuotas(payload.quota_snapshots);
  const premium = usableCopilotQuota(payload.quota_snapshots?.premium_interactions)
    ?? snapshotQuotas.find(({ key }) => isPremiumCopilotQuotaKey(key))?.quota
    ?? (!usesCredits
      ? monthlyCopilotQuota(payload.monthly_quotas?.completions, payload.limited_user_quotas?.completions, "completions")
      : undefined);
  const chat = usableCopilotQuota(payload.quota_snapshots?.chat)
    ?? snapshotQuotas.find(({ key }) => isChatCopilotQuotaKey(key))?.quota
    ?? (!usesCredits
      ? monthlyCopilotQuota(payload.monthly_quotas?.chat, payload.limited_user_quotas?.chat, "chat")
      : undefined);
  const selected = premium ?? chat ?? snapshotQuotas[0]?.quota;

  if (!selected) {
    const plan = cleanString(payload.copilot_plan);
    const planSuffix = plan ? ` Plan: ${plan}.` : "";
    if (payload.token_based_billing) {
      const planLabel = plan ? ` ${plan}` : "";
      return unavailableSource(
        "copilot",
        `Copilot${planLabel} uses pooled AI credit billing, but the internal API returned no usable AI credit quota.`,
        "api",
      );
    }
    return unavailableSource("copilot", `Copilot API returned no usable quota snapshot.${planSuffix}`, "api");
  }

  const reset = isoDate(payload.quota_reset_date);
  const used = Math.max(0, selected.entitlement - selected.remaining);
  const windows: AgentUsageWindow[] = [
    {
      kind: usesCredits ? "credits" : "requests",
      label: usesCredits ? "AI Credits" : "Requests",
      status: "available",
      used,
      limit: selected.entitlement,
      remaining: selected.remaining,
      unit: usesCredits ? "credits" : "requests",
      ...(reset ? { resetsAt: reset } : {}),
      source: "api",
    },
  ];

  return {
    provider: "copilot",
    providerLabel: "Copilot",
    ...(account ? { account } : {}),
    status: "available",
    windows,
    source: "api",
  };
}

function usableCopilotSnapshotQuotas(
  snapshots?: Record<string, CopilotQuotaSnapshot | undefined>,
): Array<{ key: string; quota: CopilotUsableQuota }> {
  return Object.entries(snapshots ?? {})
    .map(([key, snapshot]) => ({ key, quota: usableCopilotQuota(snapshot) }))
    .filter((entry): entry is { key: string; quota: CopilotUsableQuota } => entry.quota !== undefined);
}

function isPremiumCopilotQuotaKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("premium") || normalized.includes("completion") || normalized.includes("code");
}

function isChatCopilotQuotaKey(key: string): boolean {
  return key.toLowerCase().includes("chat");
}

async function fetchCopilotAccount(token: string, host: string): Promise<AgentUsageAccount | undefined> {
  try {
    const response = await fetch(`https://${host}/user`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `token ${token}`,
        "X-Github-Api-Version": "2025-04-01",
      },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { id?: number; login?: string };
    const login = cleanString(payload.login);
    if (!login) return undefined;
    return {
      id: payload.id !== undefined ? String(payload.id) : login,
      label: login,
    };
  } catch {
    return undefined;
  }
}

function normalizeGitHubAPIHost(host?: string): string {
  const trimmed = host?.trim();
  if (!trimmed || trimmed === "github.com") return "api.github.com";
  if (trimmed.startsWith("api.")) return trimmed;
  return `api.${trimmed}`;
}

function usableCopilotQuota(snapshot?: CopilotQuotaSnapshot): CopilotUsableQuota | undefined {
  if (!snapshot || snapshot.unlimited) return undefined;
  const entitlement = numberValue(snapshot.entitlement);
  const remaining = numberValue(snapshot.remaining);
  if (entitlement === undefined || remaining === undefined || entitlement <= 0) return undefined;
  return {
    entitlement,
    remaining: Math.max(0, remaining),
  };
}

function monthlyCopilotQuota(monthly?: number | string, limited?: number | string, _quotaId?: string): CopilotUsableQuota | undefined {
  const entitlement = numberValue(monthly);
  const remaining = numberValue(limited);
  if (entitlement === undefined || remaining === undefined || entitlement <= 0) return undefined;
  return {
    entitlement,
    remaining: Math.max(0, remaining),
  };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function codexWindow(
  kind: "session" | "week",
  label: string,
  window: CodexRateLimitWindow | undefined,
  source: string,
): AgentUsageWindow | undefined {
  if (!window) return undefined;

  const used = numberValue(window.usedPercent ?? window.used_percent);
  if (used === undefined) return undefined;

  const resetsAt = epochSecondsToISO(numberValue(window.resetsAt ?? window.reset_at));
  return {
    kind,
    label,
    status: "available",
    used,
    limit: 100,
    remaining: Math.max(0, 100 - used),
    unit: "percent",
    ...(resetsAt ? { resetsAt } : {}),
    source,
  };
}

function codexAccount(snapshot: CodexRPCSnapshot): AgentUsageAccount | undefined {
  const account = snapshot.account?.account;
  const email = account?.type?.toLowerCase() === "chatgpt" ? cleanString(account.email) : undefined;
  const plan = cleanString(account?.planType ?? account?.plan_type ?? snapshot.rateLimits.planType ?? snapshot.rateLimits.plan_type);
  if (!email && !plan) return undefined;
  return {
    ...(email ? { id: email, label: email } : {}),
    ...(!email && plan ? { id: plan, label: plan } : {}),
  };
}

async function fetchCodexRPCSnapshot(env: NodeJS.ProcessEnv): Promise<CodexRPCSnapshot> {
  const client = new CodexRPCClient(env);
  try {
    await client.initialize();
    const rateLimitsResponse = await client.request<{ rateLimits: CodexRateLimits }>("account/rateLimits/read");
    let account: CodexAccountResponse | undefined;
    try {
      account = await client.request<CodexAccountResponse>("account/read");
    } catch {
      account = undefined;
    }
    return {
      rateLimits: rateLimitsResponse.rateLimits,
      ...(account ? { account } : {}),
    };
  } finally {
    client.shutdown();
  }
}

class CodexRPCClient {
  private child;
  private nextID = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private stderr = "";

  constructor(private env: NodeJS.ProcessEnv) {
    this.child = spawn(resolveCodexBinary(this.env), ["-s", "read-only", "-a", "untrusted", "app-server"], {
      env: {
        ...this.env,
        PATH: effectivePath(this.env),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdout || !this.child.stdin || !this.child.stderr) {
      throw new Error("Failed to start Codex RPC process.");
    }

    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.rejectAll(new Error(`Codex RPC exited before replying (${signal ?? code})${suffix}`));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "agents", version: "1.0.0" } }, 8000);
    this.notify("initialized");
  }

  request<T>(method: string, params?: unknown, timeoutMs = 3000): Promise<T> {
    const id = this.nextID;
    this.nextID += 1;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.shutdown();
        reject(new Error(`Codex RPC timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });

    this.write({ id, method, params: params ?? {} });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params: params ?? {} });
  }

  shutdown(): void {
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private write(payload: unknown): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("Codex RPC stdin is closed.");
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(message.error.message || "Codex RPC request failed."));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

function resolveCodexBinary(env: NodeJS.ProcessEnv): string {
  return env.AGENTS_CODEX_BIN || env.CODEX_BIN || "codex";
}

function effectivePath(env: NodeJS.ProcessEnv): string {
  const existing = env.PATH || "";
  const additions = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
  ];
  return [...additions, existing].filter(Boolean).join(":");
}

function recoverCodexRateLimitsFromError(error: unknown): CodexRateLimits | undefined {
  const message = errorMessage(error);
  const json = extractJSONObjectAfter("body=", message);
  if (!json) return undefined;
  try {
    const body = JSON.parse(json) as {
      rate_limit?: {
        primary_window?: CodexRateLimitWindow;
        secondary_window?: CodexRateLimitWindow;
      };
      plan_type?: string;
    };
    return {
      primary: body.rate_limit?.primary_window,
      secondary: body.rate_limit?.secondary_window,
      planType: body.plan_type,
    };
  } catch {
    return undefined;
  }
}

function extractJSONObjectAfter(marker: string, text: string): string | undefined {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

function unavailableSource(providerID: string, message: string, source = "agents usage"): AgentUsageSource {
  const descriptor = SUPPORTED_PROVIDERS[providerID] ?? { id: providerID, label: titleCase(providerID) };
  return {
    provider: descriptor.id,
    providerLabel: descriptor.label,
    status: "unavailable",
    windows: [],
    source,
    errorMessage: message,
  };
}

function errorSource(providerID: string, message: string): AgentUsageSource {
  const descriptor = SUPPORTED_PROVIDERS[providerID] ?? { id: providerID, label: titleCase(providerID) };
  return {
    provider: descriptor.id,
    providerLabel: descriptor.label,
    status: "error",
    windows: [],
    source: "agents usage",
    errorMessage: message,
  };
}

function unavailableWindow(
  kind: "session" | "week" | "month",
  label: string,
  message: string,
  source: string,
): AgentUsageWindow {
  return {
    kind,
    label,
    status: "unavailable",
    unit: "percent",
    source,
    errorMessage: message,
  };
}

function epochSecondsToISO(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return isoTimestamp(new Date(value * 1000));
}

function isoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? isoTimestamp(date) : undefined;
}

function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cleanString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareUsageSources(lhs: AgentUsageSource, rhs: AgentUsageSource): number {
  const lhsRank = usageSourceSortRank(lhs);
  const rhsRank = usageSourceSortRank(rhs);
  if (lhsRank !== rhsRank) return lhsRank - rhsRank;
  return usageSourceLabel(lhs).localeCompare(usageSourceLabel(rhs), "en", { sensitivity: "base" });
}

function usageSourceSortRank(source: AgentUsageSource): number {
  if (source.windows.some((window) => window.status !== "unavailable" && window.status !== "error" && window.used !== undefined)) {
    return 0;
  }
  if (source.status === "available") return 1;
  if (source.status === "error") return 2;
  return 3;
}

function usageSourceLabel(source: AgentUsageSource): string {
  return [
    source.providerLabel ?? source.provider,
    source.account?.label ?? source.account?.id ?? "",
  ].join("\u0000");
}
