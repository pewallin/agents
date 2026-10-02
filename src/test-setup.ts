import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";

const agentsHome = mkdtempSync(join(tmpdir(), "agents-test-home-"));
process.env.AGENTS_HOME = agentsHome;
process.env.AGENTS_NO_AUTO_SETUP = "1";

afterAll(() => {
  rmSync(agentsHome, { recursive: true, force: true });
});
