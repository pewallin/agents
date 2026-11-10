// What the field's corner shows of a session's usage: its context in tokens and what it has cost
// so far, as the pane's header in Agents Next writes them ("43k · $0.42", "120k · 1.3 cr").

export interface SessionUsage {
  /** Tokens in context. */
  used: number;
  /** The context window; 0 when the agent's context is not known (only its spend is). */
  size: number;
  cost?: { amount: number; currency: string } | null;
}

export function tokenText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export function costText(cost: { amount: number; currency: string }): string {
  const { amount } = cost;
  const currency = cost.currency.trim();
  if (/^usd$/i.test(currency)) return `$${amount < 10 ? amount.toFixed(2) : Math.round(amount)}`;
  const figure = amount >= 10 || amount === Math.round(amount) ? String(Math.round(amount)) : amount.toFixed(1);
  if (/^credits?$/i.test(currency)) return `${figure} cr`;
  if (/^aiu$/i.test(currency)) return `${figure} AIU`;
  return currency ? `${figure} ${currency}` : figure;
}

export function hasContext(usage: SessionUsage): boolean {
  return usage.size > 0;
}

/** The context share, 0–100, or none when the window is not known. */
export function contextPercent(usage: SessionUsage): number | undefined {
  return hasContext(usage) ? (usage.used / usage.size) * 100 : undefined;
}

export function usageText(usage: SessionUsage): string {
  return [hasContext(usage) ? tokenText(usage.used) : undefined, usage.cost ? costText(usage.cost) : undefined]
    .filter(Boolean).join(" · ");
}

export function usageTitle(usage: SessionUsage): string {
  const lines: string[] = [];
  const percent = contextPercent(usage);
  if (percent !== undefined) {
    lines.push(`Context: ${Math.round(usage.used).toLocaleString("en-US")} of ${Math.round(usage.size).toLocaleString("en-US")} tokens (${Math.round(percent)} %)`);
  }
  if (usage.cost) lines.push(`Session spend: ${costText(usage.cost)}`);
  return lines.join("\n");
}
