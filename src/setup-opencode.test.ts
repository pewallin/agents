import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A fake HOME with an OpenCode config: nothing here touches the user's own.
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "agents-opencode-setup-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

async function setupOpencode() {
  vi.resetModules();
  return (await import("./setup.js")).setupOpencode();
}

it("leaves an OpenCode config it cannot parse as it is", async () => {
  const configPath = join(home, ".config", "opencode", "config.json");
  const text = `{\n  // the user's own notes\n  "model": "anthropic/claude",\n  "theme": "nord",\n}\n`;
  writeFileSync(configPath, text);

  const result = await setupOpencode();

  expect(result.action).toBe("skipped");
  expect(result.detail).toContain("could not parse");
  expect(readFileSync(configPath, "utf-8")).toBe(text);
});

it("adds the plugin to an OpenCode config and keeps the rest of it", async () => {
  const configPath = join(home, ".config", "opencode", "config.json");
  writeFileSync(configPath, JSON.stringify({ model: "anthropic/claude", plugin: ["other"] }));

  const result = await setupOpencode();

  expect(result.action).toBe("installed");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.model).toBe("anthropic/claude");
  expect(config.plugin).toEqual(["other", "opencode-agents-reporting"]);
});
