import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { createAppBundle } from "./bundle.js";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createAppBundle", () => {
  it("copies the app-managed install tree and writes bundle metadata", () => {
    const sourceRoot = makeTempDir("agents-bundle-src-");
    const outputRoot = makeTempDir("agents-bundle-out-");

    writeFixtureFile(sourceRoot, "package.json", JSON.stringify({
      name: "agents",
      version: "1.2.3",
      engines: { node: ">=22.0.0" },
    }));
    writeFixtureFile(sourceRoot, "dist/cli.js", "console.log('ok');\n");
    writeFixtureFile(sourceRoot, "extensions/pi/index.js", "export {};\n");
    writeFixtureFile(sourceRoot, "node_modules/example/package.json", "{\"name\":\"example\"}\n");
    writeFixtureFile(
      sourceRoot,
      "bridge-plugin/target/wasm32-wasip1/release/agents-bridge.wasm",
      "wasm"
    );

    const metadata = createAppBundle(outputRoot, sourceRoot);

    expect(metadata.version).toBe("1.2.3");
    expect(metadata.node).toBe(">=22.0.0");
    expect(readFileSync(join(outputRoot, "dist/cli.js"), "utf-8")).toContain("console.log");
    expect(readFileSync(join(outputRoot, "extensions/pi/index.js"), "utf-8")).toContain("export");
    expect(readFileSync(join(outputRoot, "node_modules/example/package.json"), "utf-8")).toContain("example");
    expect(readFileSync(join(outputRoot, "agents-bundle.json"), "utf-8")).toContain("\"version\": \"1.2.3\"");
    expect(metadata.optionalEntries).toContain("bridge-plugin/target/wasm32-wasip1/release/agents-bridge.wasm");
  });

  it("rejects non-empty output directories", () => {
    const sourceRoot = makeTempDir("agents-bundle-src-");
    const outputRoot = makeTempDir("agents-bundle-out-");

    writeFixtureFile(sourceRoot, "package.json", JSON.stringify({
      name: "agents",
      version: "1.2.3",
      engines: { node: ">=22.0.0" },
    }));
    writeFixtureFile(sourceRoot, "dist/cli.js", "console.log('ok');\n");
    writeFixtureFile(sourceRoot, "extensions/pi/index.js", "export {};\n");
    writeFixtureFile(sourceRoot, "node_modules/example/package.json", "{\"name\":\"example\"}\n");
    writeFixtureFile(outputRoot, "existing.txt", "busy\n");

    expect(() => createAppBundle(outputRoot, sourceRoot)).toThrow(/not empty/);
  });
});
