// What the field you write in does with text the app hands it.

/** A selection quoted for a reply, as the app's context menu sends it (Quote in Reply): each line
 *  of it after "> ", below what was written already, with room to answer under it. */
export function quoted(selection: string, draft: string): string {
  if (!selection.trim()) return draft;
  const quote = selection.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  const before = draft.trimEnd();
  return `${before ? `${before}\n\n` : ""}${quote}\n\n`;
}
