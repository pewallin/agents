// The message an agent the app makes coordinator reads first.

import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinatorStartMessage } from "./promote.js";
import { isCoordinatorPromptFor } from "./threads.js";

const base = {
  name: "Security triage", program: "/h/.agents/programs/app", protocol: "/skills/coordinator.md",
  context: "/h/.agents/programs/app/CONTEXT.md", memoryFile: "/h/.agents/programs/app/MEMORY.md",
  cli: "/h/.agents/agents-app/bin/agents-app-control", hint: "It finds your pane by itself.", skill: "/skills/SKILL.md",
};

test("a coordinator's start says the role, then numbered first steps, then where things are", () => {
  const text = coordinatorStartMessage({ ...base, start: "fresh", steps: [" Name this program once.", "", undefined] });
  const [lead, heading, steps, where] = text.split("\n\n");
  assert.match(lead, /^\*\*You are the coordinator of this work: “Security triage”\.\*\* You hand the user's work to worker agents/);
  assert.equal(heading, "First:");
  assert.deepEqual(steps.split("\n"), [
    "1. Read the coordinator protocol at /skills/coordinator.md and follow it.",
    "2. Name this program once.",
  ]);
  // OVERVIEW.md is no longer kept, and nothing opens beside the coordinator.
  assert.doesNotMatch(text, /OVERVIEW|beside you/);
  assert.match(where, /^- Program directory: \/h\/\.agents\/programs\/app\n- The CLI: \/h\/\.agents\/agents-app\/bin\/agents-app-control\. It finds your pane by itself\.\n- Everything else/);
  assert.doesNotMatch(text, /user's own instructions/);
  // The repair pass still knows a coordinator's session by it.
  assert.equal(isCoordinatorPromptFor(text, base.program), true);
});

test("an agent promoted mid-conversation keeps what it knows and writes it down first", () => {
  const promoted = coordinatorStartMessage({ ...base, start: "promoted", instructions: "/h/.agents/instructions.md" });
  assert.match(promoted, /You are now also the coordinator of this work: “Security triage”\.\*\*.*Keep all you know/);
  assert.match(promoted, /1\. Read the coordinator protocol at \/skills\/coordinator\.md and follow it from now on\.\n2\. Write what you know so far to \/h\/\.agents\/programs\/app\/CONTEXT\.md/);
  assert.match(promoted, /- The user's own instructions: \/h\/\.agents\/instructions\.md; follow them too\.$/);
  const carryOn = coordinatorStartMessage({ ...base, start: "carry-on" });
  assert.match(carryOn, /2\. Add to \/h\/\.agents\/programs\/app\/MEMORY\.md only what you know that it does not say yet\./);
  assert.doesNotMatch(promoted + carryOn, /OVERVIEW|beside you/);
});
