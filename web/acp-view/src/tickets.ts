// Ticket ids in prose (`TH-1234`) as chips, by the rules the user set in Agents Next (Settings ›
// Agents › Ticket Links, or `agents-app-control settings set agents.ticketLinks`). The app hands
// them to the page in its look (ACPViewLook.tickets in AgentsAppCore); nothing about a tracker is
// built in. An id is linked as written, only as a word of its own, and never in code or inside a
// link (the same matching as TicketLinks.matches in AgentsCore, for terminals). The
// chip's peek asks the app for the ticket's title (the ticketTitle handler), which it reads with
// the user's logins.
import { useSyncExternalStore } from "react";

export interface TicketRule {
  /** What the id starts with (`TH-`), matched as written. */
  prefix: string;
  /** An http(s) address with {id} (the whole id) or {number} (its digits). */
  url: string;
}

/** The rules of a look the app handed the page; anything malformed is left out. */
export function ticketRules(look: unknown): TicketRule[] {
  const tickets = (look as { tickets?: unknown } | null | undefined)?.tickets;
  if (!Array.isArray(tickets)) return [];
  return tickets.flatMap((value): TicketRule[] => {
    const rule = value as Partial<TicketRule> | null;
    if (!rule || typeof rule.prefix !== "string" || !rule.prefix || typeof rule.url !== "string") return [];
    if (!/^https?:\/\//i.test(rule.url) || !/\{(?:id|number)\}/.test(rule.url)) return [];
    return [{ prefix: rule.prefix, url: rule.url }];
  });
}

export interface TicketToken { start: number; end: number; id: string; href: string }

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ticket ids in a run of prose, with the address each opens. An id is a word of its own:
 *  no letter, digit or path character joins it on either side, so `TH-12-fix`, `src/TH-12` and
 *  `MATH-12` (for TH-) are not ids. */
export function ticketTokens(text: string, rules: readonly TicketRule[]): TicketToken[] {
  if (rules.length === 0 || !text) return [];
  const found: TicketToken[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_\\-/.#@])${escaped(rule.prefix)}(\\d+)(?![\\p{L}\\p{N}_\\-/@]|\\.\\p{L})`, "gu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (found.some((token) => start < token.end && end > token.start)) continue;
      const number = match[1];
      const id = `${rule.prefix}${number}`;
      const href = rule.url.replaceAll("{id}", encodeURIComponent(id)).replaceAll("{number}", number);
      found.push({ start, end, id, href });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The ticket ids in text the user typed (a message bubble shows it as written, not as
 *  markdown): those outside `code` and fenced blocks. */
export function typedTicketTokens(text: string, rules: readonly TicketRule[]): TicketToken[] {
  const tokens = ticketTokens(text, rules);
  if (tokens.length === 0 || !text.includes("`")) return tokens;
  const code = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
  return tokens.filter((token) => !code.some(([start, end]) => token.start < end && token.end > start));
}

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** Where an id is the text's own: code, links, pictures and the file chips' marks. */
const SKIPPED = new Set(["code", "pre", "a", "img", "svg", "math"]);

/** A rehype plugin: each ticket id in the prose becomes a link (`a[data-ticket]`) to its address,
 *  which the view shows as the ticket's chip.
 *  It runs after the link filter, so it makes only the addresses its rules allow (http and
 *  https, checked in ticketRules). */
export function rehypeTicketLinks(rules: readonly TicketRule[]) {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "element") {
        if (!SKIPPED.has(child.tagName ?? "") && child.properties?.dataPathRef === undefined) visit(child);
        children.push(child);
        continue;
      }
      if (child.type !== "text" || !child.value) { children.push(child); continue; }
      const tokens = ticketTokens(child.value, rules);
      if (tokens.length === 0) { children.push(child); continue; }
      let at = 0;
      for (const token of tokens) {
        if (token.start > at) children.push({ type: "text", value: child.value.slice(at, token.start) });
        children.push({ type: "element", tagName: "a", properties: { href: token.href, dataTicket: token.id }, children: [{ type: "text", value: child.value.slice(token.start, token.end) }] });
        at = token.end;
      }
      if (at < child.value.length) children.push({ type: "text", value: child.value.slice(at) });
    }
    node.children = children;
  };
  return () => (tree: HastNode) => { if (rules.length > 0) visit(tree); };
}

// The rules now: those of the look the app set before the page loaded, then of each look it hands.
let current: TicketRule[] = typeof window === "undefined" ? [] : ticketRules((window as unknown as { __agentsNextLook?: unknown }).__agentsNextLook);
const listeners = new Set<() => void>();

/** Takes the rules of a look the app handed the page. */
export function applyTicketLook(look: unknown): void {
  const next = ticketRules(look);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("agents-next-look", (event) => applyTicketLook((event as CustomEvent).detail));
}

/** The ticket rules the app set, kept current. */
export function useTicketRules(): TicketRule[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => current,
  );
}
