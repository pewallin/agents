// Which agents CLI a worker runs under: the one the app runs its own agent panes with.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { agentsCLI } from "./agent-state.js";

const saved = { HOME: process.env.HOME, AGENTS_APP_AGENTS_BIN: process.env.AGENTS_APP_AGENTS_BIN, AGENTS_CLI_PREFERRED_PATH: process.env.AGENTS_CLI_PREFERRED_PATH };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function executable(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

test("a worker runs the CLI the app installs, not a ~/.local/bin/agents of the user's own", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cli-choice-"));
  process.env.HOME = home;
  delete process.env.AGENTS_APP_AGENTS_BIN;
  delete process.env.AGENTS_CLI_PREFERRED_PATH;
  assert.equal(agentsCLI(), "agents");
  const own = executable(path.join(home, ".local", "bin", "agents"));
  assert.equal(agentsCLI(), own);
  const installed = executable(path.join(home, ".agents", "agents-cli", "app", "agents"));
  assert.equal(agentsCLI(), installed);
  const preferred = executable(path.join(home, "dev", "agents"));
  process.env.AGENTS_CLI_PREFERRED_PATH = preferred;
  assert.equal(agentsCLI(), preferred);
  process.env.AGENTS_CLI_PREFERRED_PATH = path.join(home, "missing");
  assert.equal(agentsCLI(), installed);
  process.env.AGENTS_APP_AGENTS_BIN = "/explicit/agents";
  assert.equal(agentsCLI(), "/explicit/agents");
});
