// How agents-app-control names and starts itself: it runs inside the agents CLI
// (`agents app-control ...`), and agents reach it through the agents-app-control skill's
// launcher, which says where it is and which skill it belongs to.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBuildInfo, getSelfArgv } from "../paths.js";

/** The command that runs agents-app-control: this CLI with `app-control`. */
export function appControlArgv(): string[] {
  return [...getSelfArgv(), "app-control"];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** What an agent types to run agents-app-control again: the launcher it ran (the skill's
 *  scripts/agents-app-control, which exports AGENTS_APP_CONTROL_ENTRY), else this CLI. */
export function appControlCommandText(): string {
  const entry = process.env.AGENTS_APP_CONTROL_ENTRY;
  if (entry) return shellQuote(entry);
  return appControlArgv().map(shellQuote).join(" ");
}

let versionCache: string | undefined;

/** The code that runs, so a supervisor started by an older build gives way to this one: the
 *  build's commit, or for a source checkout a hash of the app-control modules. */
export function appControlVersion(): string {
  if (versionCache !== undefined) return versionCache;
  const build = getBuildInfo();
  if (build) {
    versionCache = crypto.createHash("sha1")
      .update(`${build.version}+${build.gitCommit ?? ""}${build.dirty ? "-dirty" : ""}`)
      .digest("hex");
    return versionCache;
  }
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const hash = crypto.createHash("sha1");
    for (const name of fs.readdirSync(directory).filter(name => /\.(js|ts)$/.test(name)).sort()) {
      hash.update(name).update(fs.readFileSync(path.join(directory, name)));
    }
    versionCache = hash.digest("hex");
  } catch {
    versionCache = "";
  }
  return versionCache;
}

/** The agents-app-control skill's folder: the one whose launcher ran this command
 *  (AGENTS_APP_CONTROL_SKILL_DIR), else where the app links skills for the agents. Its
 *  SKILL.md describes the CLI; the agents-coordinator skill beside it holds the protocol. */
export function appControlSkillDirectory(): string | undefined {
  const home = os.homedir();
  const candidates = [
    process.env.AGENTS_APP_CONTROL_SKILL_DIR,
    path.join(home, ".agents", "skills", "agents-app-control"),
    path.join(home, ".claude", "skills", "agents-app-control"),
    path.join(home, ".kiro", "skills", "agents-app-control"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "SKILL.md")));
}
