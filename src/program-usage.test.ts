import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheShare, claudeUsage, codexUsage, formatProgramUsage, programUsage, type MeasureSession } from "./program-usage.js";

describe("program usage", () => {
  it("counts a Claude message once, however many chunks repeat its usage", () => {
    const usage = { input_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 40 };
    const total = claudeUsage([
      { type: "assistant", message: { id: "m1", usage } },
      { type: "assistant", message: { id: "m1", usage } },
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { id: "m2", usage: { ...usage, output_tokens: 10 } } },
    ]);
    expect(total).toEqual({ input: 4, cacheRead: 1800, cacheWrite: 200, output: 50 });
    expect(cacheShare(total)).toBe(90);
  });

  it("takes a Codex rollout's last running total, its cached input apart", () => {
    const tokens = (input: number, cached: number, output: number) => ({ payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    expect(codexUsage([tokens(100, 50, 5), { payload: { type: "agent_message" } }, tokens(300, 200, 20)])).toEqual({ input: 100, cacheRead: 200, cacheWrite: 0, output: 20 });
    expect(codexUsage([{ payload: { type: "agent_message" } }])).toBeUndefined();
  });

  it("adds up the coordinator and each thread from the program's session lists", () => {
    const program = mkdtempSync(join(tmpdir(), "program-usage-"));
    writeFileSync(join(program, "program.json"), JSON.stringify({ name: "Export fixes" }));
    writeFileSync(join(program, "coordinators.jsonl"), `${JSON.stringify({ agent: "claude", session: "c1" })}\n`);
    for (const [task, lines] of [["fix-a", [{ agent: "claude", session: "w1" }, { agent: "claude", session: "w1" }, { agent: "pi", session: "p1" }]], ["fix-b", [{ agent: "kiro", session: "k1" }]]] as const) {
      mkdirSync(join(program, "tasks", task), { recursive: true });
      writeFileSync(join(program, "tasks", task, "task.json"), JSON.stringify({ title: `Title of ${task}` }));
      writeFileSync(join(program, "tasks", task, "sessions.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
    }
    const measure: MeasureSession = (agent, session) => agent === "claude"
      ? { agent, session, measured: true, input: 10, cacheRead: 90, cacheWrite: 0, output: 5 }
      : agent === "kiro" ? { agent, session, measured: true, credits: 1.5 } : { agent, session, measured: false };
    const usage = programUsage(program, measure);
    expect(usage.name).toBe("Export fixes");
    expect(usage.coordinator.total).toEqual({ input: 10, cacheRead: 90, cacheWrite: 0, output: 5 });
    const fixA = usage.threads.find((thread) => thread.name === "fix-a")!;
    expect(fixA.sessions.map((session) => session.session)).toEqual(["w1", "p1"]);
    expect(fixA.unmeasured).toBe(1);
    expect(usage.workers).toEqual({ input: 10, cacheRead: 90, cacheWrite: 0, output: 5, credits: 1.5 });
    const text = formatProgramUsage(usage);
    expect(text).toContain("fix-a · Title of fix-a");
    expect(text).toContain("all workers");
  });
});
