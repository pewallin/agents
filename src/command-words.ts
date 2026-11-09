// A command line as a shell reads it: its words, and back. Every place that reads an agent's
// command (its TUI command in Settings, a profile, a pane's launch command) splits it here, so a
// quoted value (`--append-system-prompt "be brief"`, a path with spaces) stays one word.

/** The command's words, with quotes and backslashes as sh reads them. An unfinished quote or
 *  escape ends the last word. */
export function commandWords(command: string | undefined): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const push = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  for (const ch of command ?? "") {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaping = true;
      else current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    started = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") escaping = true;
    else current += ch;
  }
  push();
  return words;
}

/** The command's words for running it: refused when a quote or escape is left open, or when
 *  there are none. */
export function splitCommandArgv(command: string): string[] {
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) escaping = false;
    else if (quote === "'") { if (ch === "'") quote = null; }
    else if (quote === '"') { if (ch === '"') quote = null; else if (ch === "\\") escaping = true; }
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") escaping = true;
  }
  if (escaping) throw new Error("Invalid command: trailing escape");
  if (quote) throw new Error("Invalid command: unterminated quote");
  const argv = commandWords(command);
  if (argv.length === 0) throw new Error("No command specified");
  return argv;
}

/** A word as sh reads it back: as it is when it needs no quotes (a leading ~ and $VAR still
 *  expand, as they did in the command it came from), else in single quotes. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+~$-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Words back into a command line. */
export function shellCommand(words: string[]): string {
  return words.map(shellQuote).join(" ");
}
