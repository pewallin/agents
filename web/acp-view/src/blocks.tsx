// The agent's richer blocks: code with the file it belongs to in a header, Copy and Open Beside;
// notes (GitHub's > [!NOTE] and "Note:" quotes) as a quiet callout. Tables, headings and lists
// are Streamdown's, styled in view.css.
import { Children, cloneElement, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ChipHostContext, useResolved } from "./chips";
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
      <pre><code>{lines
        ? lines.map((line, index) => (
          <span key={index} className="cline">{line.map((token, at) => <span key={at} style={{ "--c": token.color, "--cd": token.dark } as React.CSSProperties}>{token.content}</span>)}{"\n"}</span>
        ))
        : code}</code></pre>
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
