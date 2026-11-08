// Review of a turn's changes beside the conversation: one file at a time, line by line. A click
// on a line number leaves a comment there; the comments go to the agent as one message.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { diffLines } from "diff";
import { shortPath, type FileChange } from "./turns";
import { highlightLines, type Lines, type Token } from "./highlight";

export interface DiffRow {
  kind: "same" | "add" | "del" | "gap";
  oldLine?: number;
  newLine?: number;
  text: string;
}

const CONTEXT = 3;

/** The rows of a file's change, with a few lines of context around each change. */
export function diffRows(oldText: string | null | undefined, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(oldText ?? "", newText)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (part.added) rows.push({ kind: "add", newLine: newLine++, text });
      else if (part.removed) rows.push({ kind: "del", oldLine: oldLine++, text });
      else rows.push({ kind: "same", oldLine: oldLine++, newLine: newLine++, text });
    }
  }
  // Keep context only near changes.
  const near = rows.map((_, index) => rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((row) => row.kind !== "same"));
  const kept: DiffRow[] = [];
  rows.forEach((row, index) => {
    if (near[index]) kept.push(row);
    else if (kept.at(-1)?.kind !== "gap") kept.push({ kind: "gap", text: "" });
  });
  while (kept[0]?.kind === "gap") kept.shift();
  while (kept.at(-1)?.kind === "gap") kept.pop();
  return kept;
}

interface Comment { path: string; edit: number; line: number; code: string; text: string }

/** The comments as one message. Each names its file and quotes its line: an agent's diff may
 *  cover only part of the file, so its line numbers need not be the file's. */
export function commentsMessage(comments: Array<Omit<Comment, "edit">>, cwd: string): string {
  const lines = comments.map((comment) => `- ${shortPath(comment.path, cwd)}, at \`${comment.code.trim()}\`: ${comment.text}`);
  return `Comments on the changes:\n${lines.join("\n")}`;
}

export function ReviewPane({ changes, cwd, agentName, onClose, onSend, focus }: {
  changes: FileChange[];
  cwd: string;
  /** The agent the comments go to; for a review with no agent, what it is of ("against main"). */
  agentName: string;
  /** Absent when the review is a pane of its own: the app closes it. */
  onClose?: () => void;
  /** Absent for changes no agent made (Agents Next's Changes): the diff is only to read. */
  onSend?: (text: string) => void;
  /** The file it opens at. */
  focus?: string;
}) {
  const [fileIndex, setFileIndex] = useState(() => Math.max(0, changes.findIndex((change) => change.path === focus)));
  const [comments, setComments] = useState<Comment[]>([]);
  const [editing, setEditing] = useState<{ path: string; edit: number; line: number; code: string } | null>(null);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const change = changes[Math.min(fileIndex, changes.length - 1)];
  const sections = useMemo(() => change.edits.map((edit) => diffRows(edit.oldText, edit.newText)), [change]);
  // Colours arrive after the plain diff shows: [edit] → { old, new } lines.
  const [colours, setColours] = useState<Array<{ old: Lines | null; next: Lines | null }>>([]);
  useEffect(() => {
    let cancelled = false;
    setColours([]);
    Promise.all(change.edits.map(async (edit) => ({
      old: await highlightLines(edit.oldText ?? "", change.path).catch(() => null),
      next: await highlightLines(edit.newText, change.path).catch(() => null),
    }))).then((result) => { if (!cancelled) setColours(result); });
    return () => { cancelled = true; };
  }, [change]);

  useEffect(() => { box.current?.focus(); }, [editing]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.metaKey && comments.length > 0 && !editing && onSend) {
        event.preventDefault();
        onSend(commentsMessage(comments, cwd));
      } else if (event.key === "Escape" && !editing && onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comments, editing, onSend, onClose, cwd]);

  const save = () => {
    if (editing && text.trim()) setComments((list) => [...list, { ...editing, text: text.trim() }]);
    setEditing(null);
    setText("");
  };

  return (
    <aside className="review" aria-label="Review">
      <div className="rhead">
        <span className="rtitle">Changes</span>
        <span className="d">{changes.length === 1 ? "1 file" : `${changes.length} files`}, {agentName}</span>
        {onClose && <button className="rclose" type="button" onClick={onClose} aria-label="Close the review">✕</button>}
      </div>
      <div className="rbar">
        {changes.map((item, index) => (
          <button type="button" key={item.path} className={`f${index === fileIndex ? " on" : ""}`} onClick={() => setFileIndex(index)} title={item.path}>
            {shortPath(item.path, cwd)}
          </button>
        ))}
        <span className="r"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span></span>
      </div>
      <div className="dv">
        <table>
          <tbody>
            {sections.map((rows, edit) => (
              <SectionRows key={edit} label={sections.length > 1 ? `Change ${edit + 1} of ${sections.length}` : undefined}>
                {rows.map((row, index) => {
                  const line = row.newLine ?? row.oldLine;
                  const at = (comment: { path: string; edit: number; line: number }) =>
                    comment.path === change.path && comment.edit === edit && comment.line === line && row.kind !== "del";
                  const here = comments.filter(at);
                  const isEditing = editing !== null && at(editing);
                  return (
                    <RowWithComments key={index} row={row}
                      tokens={row.kind === "del"
                        ? colours[edit]?.old?.[(row.oldLine ?? 0) - 1]
                        : colours[edit]?.next?.[(row.newLine ?? 0) - 1]}
                      onComment={onSend && line && row.kind !== "del" && row.kind !== "gap" ? () => { setEditing({ path: change.path, edit, line, code: row.text }); setText(""); } : undefined}>
                      {here.map((comment, n) => (
                        <tr className="cm" key={`c${n}`}><td className="n" /><td><div className="cbox done">{comment.text}</div></td></tr>
                      ))}
                      {isEditing && (
                        <tr className="cm"><td className="n" /><td>
                          <div className="cbox">
                            <textarea ref={box} value={text} rows={2} placeholder="Comment for the agent"
                              onChange={(event) => setText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); }
                                if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                              }} />
                            <span className="acts"><button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="b" onClick={save}>Comment ⏎</button></span>
                          </div>
                        </td></tr>
                      )}
                    </RowWithComments>
                  );
                })}
              </SectionRows>
            ))}
          </tbody>
        </table>
      </div>
      {onSend && (
        <div className="rfoot">
          <span>{comments.length === 0 ? "Click a line number to comment" : comments.length === 1 ? "1 comment" : `${comments.length} comments`}</span>
          <span className="sp" />
          <button className="pill" type="button" disabled={comments.length === 0} onClick={() => onSend(commentsMessage(comments, cwd))}>
            Send to {agentName} <kbd>⌘⏎</kbd>
          </button>
        </div>
      )}
    </aside>
  );
}

function SectionRows({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <>
      {label && <tr className="h"><td className="n" /><td>{label}</td></tr>}
      {children}
    </>
  );
}

function Coloured({ tokens }: { tokens: Token[] }) {
  return <>{tokens.map((token, index) => (
    <span key={index} style={{ "--c": token.color, "--cd": token.dark ?? token.color } as CSSProperties}>{token.content}</span>
  ))}</>;
}

function RowWithComments({ row, onComment, children, tokens }: { row: DiffRow; onComment?: () => void; children: ReactNode; tokens?: Token[] }) {
  if (row.kind === "gap") return <tr className="h"><td className="n" /><td>⋯</td></tr>;
  return (
    <>
      <tr className={row.kind === "add" ? "a" : row.kind === "del" ? "d" : undefined}>
        <td className={`n${onComment ? " can" : ""}`} onClick={onComment} title={onComment ? "Comment on this line" : undefined}>{row.newLine ?? row.oldLine}</td>
        <td className="code">{tokens && tokens.length > 0 ? <Coloured tokens={tokens} /> : row.text || " "}</td>
      </tr>
      {children}
    </>
  );
}
