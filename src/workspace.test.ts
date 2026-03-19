import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getWorkspacePathState, prepareWorkspaceDir } from "./workspace.js";

describe("workspace path helpers", () => {
  it("classifies existing directories as valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-ws-valid-"));
    try {
      expect(getWorkspacePathState(dir)).toBe("valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies missing directories under an existing parent as creatable", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-creatable-"));
    const target = join(root, "new-project", "nested");
    try {
      expect(getWorkspacePathState(target)).toBe("creatable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies files as invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-file-"));
    const file = join(root, "README.md");
    writeFileSync(file, "hi");
    try {
      expect(getWorkspacePathState(file)).toBe("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates missing project directories and initializes git", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-init-"));
    const target = join(root, "demo-app");
    try {
      expect(prepareWorkspaceDir(target)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses paths under a file ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-blocked-"));
    const fileParent = join(root, "not-a-dir");
    writeFileSync(fileParent, "x");
    const target = join(fileParent, "child");
    try {
      expect(getWorkspacePathState(target)).toBe("invalid");
      expect(prepareWorkspaceDir(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
