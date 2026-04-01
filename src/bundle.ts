import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(__dirname, ".."));
const BUNDLE_MANIFEST = "agents-bundle.json";

const REQUIRED_ENTRIES = [
  "dist",
  "extensions",
  "node_modules",
  "package.json",
] as const;

const OPTIONAL_ENTRIES = [
  "bridge-plugin/target/wasm32-wasip1/release/agents-bridge.wasm",
] as const;

export interface AgentsBundleMetadata {
  packageName: string;
  version: string;
  node: string;
  generatedAt: string;
  outputDir: string;
  manifestPath: string;
  requiredEntries: string[];
  optionalEntries: string[];
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  engines?: {
    node?: string;
  };
}

interface ValidatedPackageJson {
  name: string;
  version: string;
  engines: {
    node: string;
  };
}

function parsePackageJson(sourceRoot: string): PackageJsonShape {
  const packagePath = join(sourceRoot, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJsonShape;
}

function ensureBundleSource(sourceRoot: string): ValidatedPackageJson {
  for (const entry of REQUIRED_ENTRIES) {
    if (!existsSync(join(sourceRoot, entry))) {
      const detail = entry === "dist"
        ? "run `npm run build` first"
        : "install dependencies before bundling";
      throw new Error(`bundle source is missing ${entry} at ${sourceRoot}; ${detail}`);
    }
  }

  const packageJson = parsePackageJson(sourceRoot);
  if (!packageJson.name || !packageJson.version) {
    throw new Error(`bundle source package.json is missing name/version at ${sourceRoot}`);
  }
  if (!packageJson.engines?.node) {
    throw new Error(`bundle source package.json is missing engines.node at ${sourceRoot}`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    engines: {
      node: packageJson.engines.node,
    },
  };
}

function ensureEmptyOutputDir(outputDir: string) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    return;
  }

  const entries = readdirSync(outputDir);
  if (entries.length > 0) {
    throw new Error(`output directory is not empty: ${outputDir}`);
  }
}

export function createAppBundle(outputDir: string, sourceRoot: string = REPO_ROOT): AgentsBundleMetadata {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedOutputDir = resolve(outputDir);
  const packageJson = ensureBundleSource(resolvedSourceRoot);

  ensureEmptyOutputDir(resolvedOutputDir);

  for (const entry of REQUIRED_ENTRIES) {
    cpSync(
      join(resolvedSourceRoot, entry),
      join(resolvedOutputDir, entry),
      { recursive: true }
    );
  }

  const optionalEntries = OPTIONAL_ENTRIES.filter((entry) => existsSync(join(resolvedSourceRoot, entry)));
  for (const entry of optionalEntries) {
    const targetPath = join(resolvedOutputDir, entry);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(join(resolvedSourceRoot, entry), targetPath);
  }

  const metadata: AgentsBundleMetadata = {
    packageName: packageJson.name,
    version: packageJson.version,
    node: packageJson.engines.node,
    generatedAt: new Date().toISOString(),
    outputDir: resolvedOutputDir,
    manifestPath: join(resolvedOutputDir, BUNDLE_MANIFEST),
    requiredEntries: [...REQUIRED_ENTRIES],
    optionalEntries,
  };

  writeFileSync(metadata.manifestPath, JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}
