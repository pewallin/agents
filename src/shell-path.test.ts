import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, expect, it } from "vitest";
import { findOnPath } from "./shell.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it("finds an executable on PATH without a shell, and never runs a name as a command", () => {
  root = mkdtempSync(join(tmpdir(), "agents-path-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "tool"), "not executable");
  writeFileSync(join(second, "tool"), "#!/bin/sh\n");
  chmodSync(join(second, "tool"), 0o755);
  mkdirSync(join(first, "dir"));

  expect(findOnPath("tool", `${first}:${second}`)).toBe(join(second, "tool"));
  expect(findOnPath("dir", first)).toBeUndefined();
  expect(findOnPath("tool; touch pwned", `${first}:${second}`)).toBeUndefined();
  expect(findOnPath(`${second}/tool`, second)).toBeUndefined();
  expect(findOnPath("", second)).toBeUndefined();
});
