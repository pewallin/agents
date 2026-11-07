// The agent's richer blocks: code with the file it belongs to in a header, Copy and Open Beside,
// and the paths in it that exist as links;
// notes (GitHub's > [!NOTE] and "Note:" quotes) as a quiet callout. Tables, headings and lists
// are Streamdown's, styled in view.css.
import { Children, cloneElement, isValidElement, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ChipHostContext, useResolved, useResolvedNames, type ChipHost, type ChipTarget } from "./chips";
import { pathTokens } from "./paths";
import { highlightLines, languageNamed, type Lines } from "./highlight";

/** The file a fenced block names in its info string: ```swift AgentsNext/UI/Foo.swift,
 *  ```ts title="src/a.ts" or ```ts file=src/a.ts:12. */
export function fileOfMeta(meta: string | undefined): string | null {
  if (!meta) return null;
  const quoted = meta.match(/(?:title|file|filename|path)=["']?([^"'\s]+)["']?/);
  if (quoted) return quoted[1];
  const token = meta.trim().split(/\s+/).find((part) => /[/.]/.test(part) && !/^[{(]/.test(part) && !part.includes("="));
  return token ?? null;
}

function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(codeText).join("");
  if (isValidElement(children)) return codeText((children.props as { children?: ReactNode }).children);
  return "";
}

/** A fenced code block. Inline code is the chips' (markdown.tsx). */
type CodeToken = { content: string; color?: string; dark?: string };

function tokenSpan(token: CodeToken, key: number | string) {
  return token.color || token.dark
    ? <span key={key} style={{ "--c": token.color, "--cd": token.dark } as React.CSSProperties}>{token.content}</span>
    : <span key={key}>{token.content}</span>;
}

/** One line of a code block: its highlighted tokens, with each path that exists wrapped as a
 *  link (a click opens it as a chip does; the tokens are split where the path starts and ends). */
export function CodeLine({ tokens, found, host }: { tokens: CodeToken[]; found: Map<string, ChipTarget | null>; host: ChipHost | null }) {
  const text = tokens.map((token) => token.content).join("");
  const links = found.size === 0 ? [] : pathTokens(text).flatMap((token) => {
    const target = found.get(token.token);
    return target && target.kind !== "commit" && target.kind !== "bead" ? [{ ...token, target }] : [];
  });
  if (links.length === 0) return <>{tokens.map((token, at) => tokenSpan(token, at))}</>;
  const out: ReactNode[] = [];
  let group: ReactNode[] = [];
  let link: (typeof links)[number] | undefined;
  let at = 0;
  const close = () => {
    if (!link) return;
    const target = link.target;
    out.push(
      <span key={`l${link.start}`} className="cpath" role="link" title="Open beside the pane (⌥ in the editor)"
        data-path={target.kind === "file" || target.kind === "image" || target.kind === "dir" ? `${target.path}${target.line ? `:${target.line}` : ""}` : undefined}
        onClick={(event) => {
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          host?.open(target, { alternate: event.altKey, command: event.metaKey });
        }}>{group}</span>,
    );
    group = [];
    link = undefined;
  };
  tokens.forEach((token, index) => {
    let start = 0;
    while (start < token.content.length) {
      const position = at + start;
      if (link && position >= link.end) close();
      if (!link) link = links.find((candidate) => position >= candidate.start && position < candidate.end);
      const boundary = link ? link.end : (links.find((candidate) => candidate.start > position)?.start ?? Infinity);
      const end = Math.min(token.content.length, boundary - at);
      const piece = tokenSpan({ ...token, content: token.content.slice(start, end) }, `${index}-${start}`);
      if (link) group.push(piece); else out.push(piece);
      start = end;
    }
    at += token.content.length;
  });
  close();
  return <>{out}</>;
}

export function CodeBlock({ className, node, children }: { className?: string; node?: { properties?: { metastring?: string } }; children?: ReactNode }) {
  const language = className?.match(/language-([^\s]+)/)?.[1];
  const named = fileOfMeta(node?.properties?.metastring);
  const code = codeText(children).replace(/\n$/, "");
  const [lines, setLines] = useState<Lines | null>(null);
  const [copied, setCopied] = useState(false);
  const host = useContext(ChipHostContext);
  const file = useResolved(named);
  const shiki = languageNamed(language, named ?? undefined);
  useEffect(() => {
    if (!shiki || !code) { setLines(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void highlightLines(code, named ?? `x.${language}`, shiki).then((value) => { if (live) setLines(value); }, () => {});
    }, 60);
    return () => { live = false; clearTimeout(timer); };
  }, [code, shiki, named, language]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const area = document.createElement("textarea");
      area.value = code;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const openable = file && (file.kind === "file" || file.kind === "image") ? file : null;
  // Paths in the code that exist are links, as in the text (at most the first 40 a block names).
  const candidates = useMemo(() => [...new Set(code.split("\n").flatMap((line) => pathTokens(line).map((token) => token.token)))].slice(0, 40), [code]);
  const paths = useResolvedNames(candidates);
  return (
    <div className="code" data-language={language}>
      <div className="ch">
        {named
          ? <span className={`cf${openable ? " can" : ""}`} data-path={openable ? openable.path : undefined}
              onClick={(event) => openable && host?.open(openable, { alternate: event.altKey })}>{named}</span>
          : <span className="cl">{language ?? "text"}</span>}
        {named && language && <span className="cl">{language}</span>}
        <span className="sp" />
        <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        {openable && <button type="button" onClick={(event) => host?.open(openable, { alternate: event.altKey })}>Open Beside</button>}
      </div>
      <pre><code>{(lines ?? code.split("\n").map((text) => [{ content: text }])).map((line, index) => (
        <span key={index} className="cline"><CodeLine tokens={line} found={paths} host={host} />{"\n"}</span>
      ))}</code></pre>
    </div>
  );
}

const NOTE_MARK = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
const NOTE_WORD = /^\s*(Note|Tip|Important|Warning|Caution):\s*/i;

/** The kind of note a quote is, from its first words, and the quote without them. */
export function noteKind(first: string): { kind: string; rest: string } | null {
  const mark = first.match(NOTE_MARK) ?? first.match(NOTE_WORD);
  return mark ? { kind: mark[1].toLowerCase(), rest: first.slice(mark[0].length) } : null;
}

/** A quote, or a note when it starts as one. */
export function Quote({ children }: { children?: ReactNode }) {
  const parts = Children.toArray(children).filter((child) => !(typeof child === "string" && !child.trim()));
  const first = parts[0];
  if (isValidElement(first)) {
    const inner = Children.toArray((first.props as { children?: ReactNode }).children);
    if (typeof inner[0] === "string") {
      const note = noteKind(inner[0]);
      if (note) {
        const rest = [note.rest.replace(/^\n/, ""), ...inner.slice(1)].filter((part) => part !== "");
        const head = rest.length > 0 ? [cloneElement(first as ReactElement<{ children?: ReactNode }>, {}, ...rest)] : [];
        return (
          <div className={`note ${note.kind}`} role="note">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v4M8 4.8v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <div>{head}{parts.slice(1)}</div>
          </div>
        );
      }
    }
  }
  return <blockquote>{children}</blockquote>;
}
