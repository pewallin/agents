import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn, unref } = vi.hoisted(() => ({ spawn: vi.fn(), unref: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(),
  spawn,
}));

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("automatic hook setup", () => {
  it("prevents its detached setup child from launching another setup", async () => {
    directory = mkdtempSync(join(tmpdir(), "agents-auto-setup-"));
    vi.stubEnv("AGENTS_SETUP_HASH_PATH", join(directory, "hash"));
    vi.stubEnv("AGENTS_NO_AUTO_SETUP", "");
    vi.resetModules();
    spawn.mockReturnValue({ unref });
    const { autoSetupIfNeeded } = await import("./setup.js");

    autoSetupIfNeeded();
    expect(spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], "setup", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENTS_NO_AUTO_SETUP: "1" },
    });
    expect(unref).toHaveBeenCalledOnce();

    vi.stubEnv("AGENTS_NO_AUTO_SETUP", "1");
    autoSetupIfNeeded();
    expect(spawn).toHaveBeenCalledOnce();
  });
});
