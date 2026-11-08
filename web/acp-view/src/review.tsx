// The review of changes: every file in one scroll, each under a header that stays at the top while
// its diff passes and folds it away on a click. A changed line is marked where it changed; the
// lines between changes fold into a row that unfolds them. A click on a line number leaves a
// comment there; the comments go to the agent as one message.
// Keys: j/k the next and previous change, ] and [ the next and previous file.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { diffLines, diffWordsWithSpace } from "diff";
import { shortPath, type FileChange } from "./turns";
import { highlightLines, type Lines, type Token } from "./highlight";

export interface DiffRow {
  kind: "same" | "add" | "del" | "gap";
  oldLine?: number;
  newLine?: number;
  text: string;
  /** A gap's unchanged lines, shown when it unfolds. */
  hidden?: DiffRow[];
  /** A changed line paired with one on the other side: where it differs, as [start, end) in its text. */
  marks?: Array<[number, number]>;
}

const CONTEXT = 3;
/** A run of unchanged lines shorter than this shows: folding it would hide less than its row. */
const MIN_GAP = 3;
/** Past this many rows a file's diff starts folded, for the page to stay quick. */
const LARGE = 1500;
/** The sticky file header's height, and where a change lands below it when j or k goes to it. */
const HEADER = 34;
const LANDING = 48;

/** The rows of a file's change: a few lines of context around each change, the rest folded into
 *  gaps that hold their lines. */
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
  if (rows.length === 1 && rows[0].kind === "same" && rows[0].text === "") return [];
  markChangedWords(rows);
  const near = rows.map((_, index) => rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((row) => row.kind !== "same"));
  const kept: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (run.length >= MIN_GAP) kept.push({ kind: "gap", text: "", hidden: run });
    else kept.push(...run);
    run = [];
  };
  rows.forEach((row, index) => {
    if (near[index]) { flush(); kept.push(row); } else run.push(row);
  });
  flush();
  return kept;
}

/** Pairs each run of removed lines with the added lines right after it, line by line, and marks
 *  the words that differ, unless the lines share too little for the marks to help. */
function markChangedWords(rows: DiffRow[]): void {
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "del") { index++; continue; }
    const dels: DiffRow[] = [];
    while (rows[index]?.kind === "del") dels.push(rows[index++]);
    const adds: DiffRow[] = [];
    while (rows[index]?.kind === "add") adds.push(rows[index++]);
    for (let pair = 0; pair < Math.min(dels.length, adds.length); pair++) {
      const marks = changedWords(dels[pair].text, adds[pair].text);
      if (marks) { dels[pair].marks = marks.old; adds[pair].marks = marks.next; }
    }
  }
}

/** Where two versions of a line differ, word by word; null when they share too little. */
export function changedWords(oldText: string, newText: string): { old: Array<[number, number]>; next: Array<[number, number]> } | null {
  if (oldText.length > 600 || newText.length > 600 || oldText === newText) return null;
  const old: Array<[number, number]> = [];
  const next: Array<[number, number]> = [];
  let atOld = 0;
  let atNew = 0;
  let same = 0;
  const push = (list: Array<[number, number]>, start: number, end: number) => {
    const last = list.at(-1);
    if (last && last[1] === start) last[1] = end; else list.push([start, end]);
  };
  for (const part of diffWordsWithSpace(oldText, newText)) {
    const length = part.value.length;
    if (part.removed) { push(old, atOld, atOld + length); atOld += length; }
    else if (part.added) { push(next, atNew, atNew + length); atNew += length; }
    else { atOld += length; atNew += length; same += part.value.trim().length; }
  }
  // Lines that share little are a rewrite: marking nearly all of both says nothing.
  const longest = Math.max(oldText.trim().length, newText.trim().length);
  if (longest === 0 || same / longest < 0.4) return null;
  return { old, next };
}

interface Comment { path: string; edit: number; line: number; code: string; text: string }

/** The comments as one message. Each names its file and quotes its line: an agent's diff may
 *  cover only part of the file, so its line numbers need not be the file's. */
export function commentsMessage(comments: Array<Omit<Comment, "edit">>, cwd: string): string {
  const lines = comments.map((comment) => `- ${shortPath(comment.path, cwd)}, at \`${comment.code.trim()}\`: ${comment.text}`);
  return `Comments on the changes:\n${lines.join("\n")}`;
}

/** A path as its name and the folder it is in; a path relative to the repository (git's) stays whole. */
export function splitPath(path: string, cwd: string): { name: string; dir: string } {
  const short = path.startsWith("/") ? shortPath(path, cwd) : path;
  const at = short.lastIndexOf("/");
  return at < 0 ? { name: short, dir: "" } : { name: short.slice(at + 1), dir: short.slice(0, at) };
}

function fileStatus(change: FileChange): "new" | "deleted" | undefined {
  if (change.edits.length === 0) return undefined;
  if (change.edits.every((edit) => edit.oldText === null) && change.removed === 0) return "new";
  if (change.edits.every((edit) => edit.newText === "" && edit.oldText) && change.added === 0) return "deleted";
  return undefined;
}

interface Editing { path: string; edit: number; line: number; code: string }

export function ReviewPane({ changes, cwd, agentName, onClose, onSend, focus, message }: {
  changes: FileChange[];
  cwd: string;
  /** The agent the comments go to; for a review with no agent, what it is of ("commit 7da6d0e"). */
  agentName: string;
  /** Absent when the review is a pane of its own: the app closes it. */
  onClose?: () => void;
  /** Absent for changes no agent made (Agents Next's Changes): the diff is only to read. */
  onSend?: (text: string) => void;
  /** The file it opens at. */
  focus?: string;
  /** A commit's message, for a review of a commit. */
  message?: string;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [current, setCurrent] = useState(() => Math.max(0, changes.findIndex((change) => change.path === focus)));
  const scroller = useRef<HTMLDivElement>(null);
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);

  const toggleFold = useCallback((path: string, open?: boolean) => setFolded((set) => {
    const next = new Set(set);
    if (open ?? next.has(path)) next.delete(path); else next.add(path);
    return next;
  }), []);

  const sectionAt = (index: number) => scroller.current?.querySelector<HTMLElement>(`section.rf[data-index="${index}"]`) ?? null;
  const goToFile = useCallback((index: number) => {
    const section = scroller.current?.querySelector<HTMLElement>(`section.rf[data-index="${index}"]`);
    if (!section || !scroller.current) return;
    scroller.current.scrollTop = section.offsetTop;
    setCurrent(index);
  }, []);

  // Opened at a file: that file is at the top.
  useLayoutEffect(() => {
    const index = changes.findIndex((change) => change.path === focus);
    if (index > 0) goToFile(index);
  }, [changes, focus, goToFile]);

  // The file whose header is at the top is the current one, for the menu and for ] and [.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = element.scrollTop + 1;
        let found = 0;
        element.querySelectorAll<HTMLElement>("section.rf").forEach((section) => {
          if (section.offsetTop <= top) found = Number(section.dataset.index);
        });
        setCurrent(found);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { element.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, []);

  /** The next or previous change below or above where the last one landed, across files. */
  const goToChange = useCallback((direction: 1 | -1) => {
    const element = scroller.current;
    if (!element) return;
    const base = element.getBoundingClientRect().top - element.scrollTop;
    const line = element.scrollTop + HEADER + LANDING;
    const offsets = [...element.querySelectorAll<HTMLElement>("tr[data-hunk]")].map((row) => row.getBoundingClientRect().top - base);
    const target = direction === 1 ? offsets.find((top) => top > line + 2) : [...offsets].reverse().find((top) => top < line - 2);
    if (target !== undefined) element.scrollTop = target - HEADER - LANDING;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === "TEXTAREA" || event.target.tagName === "INPUT");
      if (event.key === "Enter" && event.metaKey && comments.length > 0 && !editing && onSend) {
        event.preventDefault();
        onSend(commentsMessage(comments, cwd));
        return;
      }
      if (event.key === "Escape" && !editing && onClose) { onClose(); return; }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") { event.preventDefault(); goToChange(1); }
      else if (event.key === "k") { event.preventDefault(); goToChange(-1); }
      else if (event.key === "]") { event.preventDefault(); goToFile(Math.min(changes.length - 1, current + 1)); }
      else if (event.key === "[") {
        event.preventDefault();
        // [ goes to the top of the current file first, as a page's back does.
        const section = sectionAt(current);
        const atTop = !section || !scroller.current || scroller.current.scrollTop <= section.offsetTop + 2;
        goToFile(atTop ? Math.max(0, current - 1) : current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comments, editing, onSend, onClose, cwd, current, changes.length, goToChange, goToFile]);

  return (
    <aside className="review" aria-label="Review">
      <div className="rhead">
        <div className="rtop">
          <span className="rtitle">Changes</span>
          <FileMenu changes={changes} cwd={cwd} current={current} onPick={goToFile} />
          <span className="d rwhat">{agentName}</span>
          <span className="sp" />
          <span className="stat"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
          {onClose && <button className="rclose" type="button" onClick={onClose} aria-label="Close the review">✕</button>}
        </div>
        {message && <CommitMessage text={message} />}
      </div>
      <div className="dv" ref={scroller}>
        {changes.map((change, index) => (
          <FileSection key={change.path} index={index} change={change} cwd={cwd}
            folded={folded.has(change.path)} onToggle={(open) => toggleFold(change.path, open)}
            comments={comments.filter((comment) => comment.path === change.path)}
            editing={editing?.path === change.path ? editing : null}
            canComment={!!onSend}
            onEdit={setEditing}
            onComment={(comment) => setComments((list) => [...list, comment])}
            onRemove={(comment) => setComments((list) => list.filter((item) => item !== comment))} />
        ))}
        {changes.length > 1 && <div className="rend">j and k step through the changes, ] and [ through the files</div>}
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

/** "5 files ⌄": the files, to jump to one. */
function FileMenu({ changes, cwd, current, onPick }: { changes: FileChange[]; cwd: string; current: number; onPick: (index: number) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  if (changes.length === 1) return <span className="d">1 file</span>;
  return (
    <span className="fmenu" ref={box}>
      <button type="button" className={`fbtn${open ? " on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        {changes.length} files<Chevron open={open} down />
      </button>
      {open && (
        <div className="flist" role="menu">
          {changes.map((change, index) => {
            const { name, dir } = splitPath(change.path, cwd);
            return (
              <button type="button" role="menuitem" key={change.path} className={`fi${index === current ? " on" : ""}`}
                onClick={() => { onPick(index); setOpen(false); }} title={change.path}>
                <span className="fn">{name}</span>
                <span className="fd"><bdi>{dir}</bdi></span>
                <span className="stat"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span></span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/** A commit's message: its first lines, the rest on a click. */
function CommitMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const long = trimmed.length > 160 || trimmed.includes("\n");
  return (
    <div className={`rmsg${open ? " open" : ""}${long ? " long" : ""}`} onClick={long ? () => setOpen(!open) : undefined}
      title={long ? (open ? "Show less" : "Show the whole message") : undefined}>
      {trimmed}
    </div>
  );
}

function Chevron({ open, down }: { open: boolean; down?: boolean }) {
  return (
    <svg className={`chev${open ? " open" : ""}${down ? " down" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileSection({ index, change, cwd, folded, onToggle, comments, editing, canComment, onEdit, onComment, onRemove }: {
  index: number;
  change: FileChange;
  cwd: string;
  folded: boolean;
  onToggle: (open?: boolean) => void;
  comments: Comment[];
  editing: Editing | null;
  canComment: boolean;
  onEdit: (editing: Editing | null) => void;
  onComment: (comment: Comment) => void;
  onRemove: (comment: Comment) => void;
}) {
  const sections = useMemo(() => change.edits.map((edit) => diffRows(edit.oldText, edit.newText)), [change]);
  const size = sections.reduce((sum, rows) => sum + rows.length, 0);
  // A large diff starts folded; its header says why.
  const [large, setLarge] = useState(size > LARGE);
  const shut = folded || large;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const element = useRef<HTMLElement>(null);
  const { name, dir } = splitPath(change.path, cwd);
  const status = fileStatus(change);

  // Colours come once the file is near the screen, after the plain diff shows.
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !element.current) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: "800px 0px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [near]);
  const [colours, setColours] = useState<Array<{ old: Lines | null; next: Lines | null }>>([]);
  useEffect(() => {
    if (!near || shut || colours.length > 0) return;
    let cancelled = false;
    Promise.all(change.edits.map(async (edit) => ({
      old: await highlightLines(edit.oldText ?? "", change.path).catch(() => null),
      next: await highlightLines(edit.newText, change.path).catch(() => null),
    }))).then((result) => { if (!cancelled) setColours(result); });
    return () => { cancelled = true; };
  }, [change, near, shut, colours.length]);

  const toggle = () => {
    if (large) { setLarge(false); onToggle(true); } else onToggle();
  };

  const renderRow = (row: DiffRow, edit: number, key: string, hunk: boolean) => {
    const line = row.newLine ?? row.oldLine;
    const at = (item: { edit: number; line: number }) => item.edit === edit && item.line === line && row.kind !== "del";
    const here = comments.filter(at);
    const tokens = row.kind === "del" ? colours[edit]?.old?.[(row.oldLine ?? 0) - 1] : colours[edit]?.next?.[(row.newLine ?? 0) - 1];
    const commentable = canComment && line !== undefined && row.kind !== "del";
    return (
      <RowWithComments key={key} row={row} tokens={tokens} hunk={hunk}
        onComment={commentable ? () => onEdit({ path: change.path, edit, line: line!, code: row.text }) : undefined}>
        {here.map((comment, n) => (
          <tr className="cm" key={`c${n}`}><td className="n" /><td className="s" /><td>
            <div className="cbox done">
              <span>{comment.text}</span>
              <button type="button" className="cx" onClick={() => onRemove(comment)} aria-label="Remove the comment" title="Remove the comment">✕</button>
            </div>
          </td></tr>
        ))}
        {editing && at(editing) && <CommentBox onSave={(text) => { onComment({ ...editing, text }); onEdit(null); }} onCancel={() => onEdit(null)} />}
      </RowWithComments>
    );
  };

  return (
    <section className={`rf${shut ? " shut" : ""}`} data-index={index} data-path={change.path} ref={element}>
      <div className="fh" onClick={toggle} title={change.path}>
        <Chevron open={!shut} />
        <span className="fn">{name}</span>
        {dir && <span className="fd"><bdi>{dir}</bdi></span>}
        {status && <span className="ftag">{status === "new" ? "New" : "Deleted"}</span>}
        {large && <span className="ftag">Large, folded</span>}
        <span className="sp" />
        <span className="stat"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span></span>
      </div>
      {!shut && (size === 0
        ? <div className="fempty">{change.edits.length === 0 ? "No diff to show for this file." : "Binary, too large or empty: nothing to show."}</div>
        : (
          <table>
            <tbody>
              {sections.map((rows, edit) => (
                <SectionRows key={edit} label={sections.length > 1 ? `Change ${edit + 1} of ${sections.length}` : undefined}>
                  {rows.flatMap((row, index): ReactNode[] => {
                    const id = `${edit}:${index}`;
                    if (row.kind !== "gap") {
                      const previous = rows[index - 1]?.kind;
                      const hunk = row.kind !== "same" && (previous === undefined || previous === "same" || previous === "gap");
                      return [renderRow(row, edit, id, hunk)];
                    }
                    if (expanded.has(id)) return (row.hidden ?? []).map((hidden, n) => renderRow(hidden, edit, `${id}:${n}`, false));
                    const count = row.hidden?.length ?? 0;
                    return [(
                      <tr className="gap" key={id} onClick={() => setExpanded((set) => new Set(set).add(id))} title="Show these lines">
                        <td className="n">⋯</td><td className="s" />
                        <td>{count} unchanged lines</td>
                      </tr>
                    )];
                  })}
                </SectionRows>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

function CommentBox({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const save = () => { if (text.trim()) onSave(text.trim()); else onCancel(); };
  return (
    <tr className="cm"><td className="n" /><td className="s" /><td>
      <div className="cbox">
        <textarea ref={box} value={text} rows={2} placeholder="Comment for the agent"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
          }} />
        <span className="acts"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="b" onClick={save}>Comment ⏎</button></span>
      </div>
    </td></tr>
  );
}

function SectionRows({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <>
      {label && <tr className="h"><td className="n" /><td className="s" /><td>{label}</td></tr>}
      {children}
    </>
  );
}

type Piece = { content: string; color?: string; dark?: string };

/** A line's text in its colours, with its changed words marked. */
export function linePieces(text: string, tokens: Token[] | undefined, marks: Array<[number, number]> | undefined): Array<Piece & { marked?: boolean }> {
  const pieces: Piece[] = tokens && tokens.length > 0 ? tokens : [{ content: text }];
  if (!marks || marks.length === 0) return pieces;
  const out: Array<Piece & { marked?: boolean }> = [];
  let at = 0;
  for (const piece of pieces) {
    let start = 0;
    while (start < piece.content.length) {
      const offset = at + start;
      const mark = marks.find(([from, to]) => offset >= from && offset < to);
      const edge = mark ? mark[1] : Math.min(Infinity, ...marks.map(([from]) => from).filter((from) => from > offset));
      const end = Math.min(piece.content.length, edge - at);
      out.push({ ...piece, content: piece.content.slice(start, end), marked: !!mark });
      start = end;
    }
    at += piece.content.length;
  }
  return out;
}

function LineText({ text, tokens, marks }: { text: string; tokens?: Token[]; marks?: Array<[number, number]> }) {
  if (!text) return <> </>;
  return <>{linePieces(text, tokens, marks).map((piece, index) => {
    const style = piece.color ? { "--c": piece.color, "--cd": piece.dark ?? piece.color } as CSSProperties : undefined;
    return <span key={index} className={piece.marked ? "x" : undefined} style={style}>{piece.content}</span>;
  })}</>;
}

function RowWithComments({ row, onComment, children, tokens, hunk }: { row: DiffRow; onComment?: () => void; children: ReactNode; tokens?: Token[]; hunk: boolean }) {
  return (
    <>
      <tr className={row.kind === "add" ? "a" : row.kind === "del" ? "d" : undefined} data-hunk={hunk ? "" : undefined}>
        <td className={`n${onComment ? " can" : ""}${row.kind === "del" ? " old" : ""}`} onClick={onComment} title={onComment ? "Comment on this line" : undefined}>
          {row.newLine ?? row.oldLine}
        </td>
        <td className="s">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</td>
        <td className="tx"><LineText text={row.text} tokens={tokens} marks={row.marks} /></td>
      </tr>
      {children}
    </>
  );
}
