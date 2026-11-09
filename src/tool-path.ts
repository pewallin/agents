// Where the tools this CLI runs are found, most preferred first: the user's own installs
// (~/.local/bin holds the CLI Agents Next installs), Node's through nvm, then Homebrew and the
// system. Agents Next's ToolSearchPath (AgentsCore) has the same list.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_TOOL_DIRECTORIES = [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"];
export const NVM_GLOB = ".nvm/versions/node/*/bin";
export const SYSTEM_TOOL_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** A PATH for a process: the directories above, then `existing`, each once. */
export function toolSearchPath(existing: string | undefined, home: string = homedir()): string {
  const nvmRoot = join(home, ".nvm", "versions", "node");
  let nvm: string[] = [];
  try {
    nvm = readdirSync(nvmRoot).sort().map((version) => join(nvmRoot, version, "bin")).filter((dir) => existsSync(dir));
  } catch {}
  const all = [...HOME_TOOL_DIRECTORIES.map((dir) => join(home, dir)), ...nvm, ...SYSTEM_TOOL_DIRECTORIES, ...(existing ?? "").split(":")];
  return [...new Set(all.filter(Boolean))].join(":");
}

/** Shell lines that give $PATH the directories above that exist, most preferred first, before a
 *  command. */
export function toolSearchPathShellLines(fn = "agents_prepend_path_dir"): string[] {
  return [
    `${fn}() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="$1\${PATH:+:$PATH}" ;; esac; }`,
    ...[...SYSTEM_TOOL_DIRECTORIES].reverse().map((dir) => `${fn} "${dir}"`),
    `for agents_tool_dir in "$HOME"/${NVM_GLOB}; do ${fn} "$agents_tool_dir"; done`,
    ...[...HOME_TOOL_DIRECTORIES].reverse().map((dir) => `${fn} "$HOME/${dir}"`),
    `unset -f ${fn}`,
    "export PATH",
  ];
}
