// Compiles the CLI to a single executable with Bun, so it runs without node or node_modules.
//
//   npm run build:binary                         # this machine's platform
//   npm run build:binary -- --target all         # every platform below
//   npm run build:binary -- --target darwin-arm64 --outdir /tmp/agents-bin
//
// Each target gets <outdir>/<target>/ with:
//   agents        the executable
//   extensions/   hook scripts and agent extensions; `agents setup` links agents to these
//   acp-view/     the prebuilt ACP web view `agents acp-host` serves (npm run build:web)
//   build.json    version, git commit, whether src/ had uncommitted changes, target and build
//                 time (also baked into the binary)
// The code lives in Bun's virtual file system, so the binary finds extensions/ next to itself
// (src/paths.ts getResourceRoot). Keep the directory together when installing it.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Target = (typeof TARGETS)[number];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hostTarget(): Target {
  const target = `${process.platform}-${process.arch}` as Target;
  if (!TARGETS.includes(target)) throw new Error(`unsupported host ${target}; pass --target`);
  return target;
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const requested = option("--target") ?? hostTarget();
const targets: Target[] = requested === "all" ? [...TARGETS] : requested.split(",") as Target[];
for (const target of targets) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}; use ${TARGETS.join(", ")} or all`);
}
const outdir = resolve(option("--outdir") ?? join(ROOT, "dist-bin"));

// The ACP web view is plain static files, the same for every target.
execFileSync("npm", ["run", "-s", "build:web"], { cwd: ROOT, stdio: "inherit" });
const ACP_VIEW = join(ROOT, "dist-web", "acp-view");

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version as string;
const dirty = git("status", "--porcelain", "--", "src", "extensions", "web", "package.json", "package-lock.json") !== "";
const gitCommit = git("rev-parse", "HEAD");

for (const target of targets) {
  const dir = join(outdir, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const info = { version, gitCommit, dirty, target, builtAt: new Date().toISOString() };

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "cli.ts")],
    compile: { target: `bun-${target}`, outfile: join(dir, "agents") },
    minify: true,
    define: {
      AGENTS_BUILD_INFO: JSON.stringify(JSON.stringify(info)),
      // React's production build: faster, and no development warnings in `agents ls`.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [{
      // Ink imports react-devtools-core only when DEV=true; it is not a dependency.
      name: "no-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export default { initialize() {}, connectToDevTools() {} };",
          loader: "js",
        }));
      },
    }],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target}`);
  }

  cpSync(join(ROOT, "extensions"), join(dir, "extensions"), { recursive: true });
  cpSync(ACP_VIEW, join(dir, "acp-view"), { recursive: true });
  writeFileSync(join(dir, "build.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`${target}: ${join(dir, "agents")} (${version}+${gitCommit.slice(0, 12)}${dirty ? "-dirty" : ""})`);
}
