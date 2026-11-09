import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { toolSearchPath, toolSearchPathShellLines } from "./tool-path.js";

describe("the tool search path", () => {
  it("puts the user's own tools first, then nvm's, Homebrew's and the system's, then what was there", () => {
    const home = mkdtempSync(join(tmpdir(), "tool-path-"));
    try {
      mkdirSync(join(home, ".nvm", "versions", "node", "v24.1.0", "bin"), { recursive: true });
      expect(toolSearchPath("/usr/bin:/custom/bin", home).split(":")).toEqual([
        join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, ".bun/bin"), join(home, ".cargo/bin"),
        join(home, ".nvm/versions/node/v24.1.0/bin"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/custom/bin",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives a shell the same order", () => {
    const home = mkdtempSync(join(tmpdir(), "tool-path-"));
    try {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      const path = execFileSync("/bin/sh", ["-c", [...toolSearchPathShellLines("p"), `printf %s "$PATH"`].join("; ")], { env: { HOME: home, PATH: "/custom/bin" }, encoding: "utf8" }).split(":");
      expect(path[0]).toBe(join(home, ".local/bin"));
      expect(path.at(-1)).toBe("/custom/bin");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
