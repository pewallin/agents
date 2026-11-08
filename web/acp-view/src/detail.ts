// How much of a turn's work the view shows (cycled with ⌃O, remembered per pane), and the one
// line a finished turn's steps fold into.
import type { ToolCall } from "./session-state";
import { parseAgentCommand } from "./coordination";
import { duration, toolOutput, type Turn } from "./turns";

/** An agent's own coordination command: it has a row of its own, it is not one of "N commands". */
function isCoordinationCommand(call: ToolCall): boolean {
  const input = (call.rawInput ?? {}) as { command?: unknown };
  const command = Array.isArray(input.command) ? input.command.join(" ") : typeof input.command === "string" ? input.command : "";
  return parseAgentCommand(command) !== null;
}

export type DetailLevel = "results" | "steps" | "everything";
export const DETAIL_LEVELS: DetailLevel[] = ["results", "steps", "everything"];
export const DETAIL_TITLES: Record<DetailLevel, string> = { results: "Results", steps: "Steps", everything: "Everything" };

const STORAGE_KEY = "agents-acp-detail";

/** The level this pane's view had: the page's storage is the pane host's origin, one per pane. */
export function storedDetailLevel(): DetailLevel {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return DETAIL_LEVELS.includes(value as DetailLevel) ? (value as DetailLevel) : "steps";
  } catch {
    return "steps";
  }
}

export function storeDetailLevel(level: DetailLevel): void {
  try { localStorage.setItem(STORAGE_KEY, level); } catch { /* no storage */ }
}

export function nextDetailLevel(level: DetailLevel): DetailLevel {
  return DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(level) + 1) % DETAIL_LEVELS.length];
}

/** Tests a command's output reports: the last summary line a test runner printed. */
export function testResult(output: string): { passed: number; failed: number } | null {
  let found: { passed: number; failed: number } | null = null;
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => { passed: number; failed: number }]> = [
    // XCTest / swift test: "Executed 18 tests, with 0 failures"
    [/Executed (\d+) tests?, with (\d+) failures?/g, (m) => ({ passed: Number(m[1]) - Number(m[2]), failed: Number(m[2]) })],
    // Swift Testing: "✔ Test run with 25 tests in 3 suites passed", "✘ Test run with 651 tests ... failed ... with 8 issues"
    [/Test run with (\d+) tests?[^\n]*?passed/g, (m) => ({ passed: Number(m[1]), failed: 0 })],
    [/Test run with (\d+) tests?[^\n]*?failed/g, () => ({ passed: 0, failed: 1 })],
    // vitest / jest: "Tests  3 failed | 31 passed (34)", "Tests: 2 failed, 40 passed, 42 total"
    [/Tests:?\s+(?:(\d+) failed[,|\s]+)?(\d+) passed/g, (m) => ({ passed: Number(m[2]), failed: Number(m[1] ?? 0) })],
    // pytest: "18 passed, 2 failed in 1.2s", "== 5 passed in"
    [/(\d+) passed(?:, (\d+) failed)?(?: in [\d.]+s)/g, (m) => ({ passed: Number(m[1]), failed: Number(m[2] ?? 0) })],
    // mocha / node --test: "# pass 40" "# fail 0", "40 passing"
    [/[#ℹ] pass (\d+)\s+[#ℹ] fail (\d+)/g, (m) => ({ passed: Number(m[1]), failed: Number(m[2]) })],
    [/(\d+) passing/g, (m) => ({ passed: Number(m[1]), failed: 0 })],
    // cargo: "test result: ok. 12 passed; 0 failed"
    [/test result: \w+\. (\d+) passed; (\d+) failed/g, (m) => ({ passed: Number(m[1]), failed: Number(m[2]) })],
  ];
  let at = -1;
  for (const [pattern, read] of patterns) {
    for (const match of output.matchAll(pattern)) {
      if ((match.index ?? 0) >= at) { at = match.index ?? 0; found = read(match); }
    }
  }
  return found;
}

/** The one line a finished turn's steps fold into: "Worked 2m 14s · read 5 files · 3 edits ·
 *  18 tests passed". */
export function turnSummary(turn: Turn): string {
  const calls = turn.steps.flatMap((step): ToolCall[] => (step.type === "tool" ? [step.call] : []));
  const parts: string[] = [];
  const timed = turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt - turn.startedAt >= 1000;
  parts.push(timed ? `Worked ${duration(turn.endedAt! - turn.startedAt!)}` : "Worked");
  const read = new Set(calls.filter((call) => call.kind === "read").flatMap((call) => (call.locations.length ? call.locations.map((location) => location.path) : [call.id])));
  if (read.size) parts.push(`read ${read.size} ${read.size === 1 ? "file" : "files"}`);
  const edits = calls.filter((call) => call.kind === "edit" || call.kind === "delete" || call.kind === "move").length;
  if (edits) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
  const searches = calls.filter((call) => call.kind === "search").length;
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  const commands = calls.filter((call) => call.kind === "execute" && !isCoordinationCommand(call));
  let tests: { passed: number; failed: number } | null = null;
  for (const call of commands) tests = testResult(toolOutput(call)) ?? tests;
  if (tests) parts.push(tests.failed ? `${tests.failed} ${tests.failed === 1 ? "test" : "tests"} failed` : `${tests.passed} ${tests.passed === 1 ? "test" : "tests"} passed`);
  else if (commands.length) parts.push(`${commands.length} ${commands.length === 1 ? "command" : "commands"}`);
  if (!timed && parts.length === 1) parts.push(`${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}`);
  return parts.join(" · ");
}

/** Steps that failed: counted on the folded line ("· 1 failed"); their output opens on a click. */
export function failedCalls(turn: Turn): ToolCall[] {
  return turn.steps.flatMap((step) => (step.type === "tool" && step.call.status === "failed" ? [step.call] : []));
}

/** The step a turn ended on when it failed and the agent said nothing after it: the one failure
 *  that shows outside the folded steps. A failure the agent went on from stays in the fold, as in
 *  Claude and Codex. */
export function endingFailure(turn: Turn): ToolCall | null {
  if (turn.answer.some((item) => item.text.trim())) return null;
  const last = turn.steps.at(-1);
  return last?.type === "tool" && last.call.status === "failed" ? last.call : null;
}

/** The last lines of a step's output, for the step that is running. */
export function lastLines(text: string, count = 3): string[] {
  return text.replace(/\s+$/, "").split("\n").filter((line) => line.trim()).slice(-count);
}

/** Steps the reader opened, by tool call id: a step stays open while its output arrives, when it
 *  ends, and when the view draws it again. */
const opened = new Map<string, boolean>();

export function isOpened(id: string, level: DetailLevel): boolean {
  return opened.get(id) ?? level === "everything";
}

export function setOpened(id: string, value: boolean): void {
  opened.set(id, value);
}

/** Whether a step opens: one that is running always does (its command, and its output as it
 *  comes, or that none came yet), a finished one when it has output or a longer command. */
export function canExpand(call: Pick<ToolCall, "status">, output: string, longCommand: boolean): boolean {
  return call.status === "pending" || call.status === "in_progress" || Boolean(output) || longCommand;
}
