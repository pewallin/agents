// Where an agent's edits of its answers are kept, and what a view needs of them (answer-edits.ts):
// a coordinator's in its conversation (<program>/thread.jsonl), a thread's in
// <program>/tasks/<task>/edits.jsonl. The ACP host reads them for the pane's view.
import fs from "node:fs";
import path from "node:path";
import { threadFile } from "./conversation.js";

export interface AnswerEdit {
  kind: "edit";
  id: string;
  at: string;
  by: "coordinator" | "worker";
  turn?: string;
  session?: string;
  /** The answer as the agent gave it: a view finds the answer by it. */
  original: string;
  text: string;
}

/** An answer's text as a view and the CLI compare it: whitespace runs as one space. */
export function answerKey(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function editsFile(program: string, task: string): string {
  return path.join(program, "tasks", task, "edits.jsonl");
}

/** The edits of a thread's answers, oldest first: a coordinator's (no task) from its
 *  conversation, a thread's from its edits file. */
export function readAnswerEdits(program: string, task?: string): AnswerEdit[] {
  const file = task ? editsFile(program, task) : threadFile(program);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const edits: AnswerEdit[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as Partial<AnswerEdit>;
      if (value?.kind === "edit" && typeof value.original === "string" && typeof value.text === "string" && typeof value.at === "string") edits.push(value as AnswerEdit);
    } catch { /* a torn line */ }
  }
  return edits;
}

/** What a view needs: per answer (by its original text) its latest text and when it was edited. */
export function shownEdits(edits: AnswerEdit[]): Array<{ original: string; text: string; at: string }> {
  const latest = new Map<string, { original: string; text: string; at: string }>();
  for (const edit of edits) latest.set(answerKey(edit.original), { original: edit.original, text: edit.text, at: edit.at });
  return [...latest.values()];
}
