// Agent text as markdown: Streamdown, which renders unfinished blocks while a reply streams.
// Code highlighting (Shiki, through @streamdown/code) is loaded after the first paint and then
// shared by every message.
import { useEffect, useState, type ReactNode } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
// The fade-in of words as a reply streams (Streamdown's animate plugin and its keyframes).
import "streamdown/styles.css";
import { CodeBlock, Quote } from "./blocks";
import { NamedChip } from "./chips";
import { rehypePathRefs } from "./paths";

type Plugins = NonNullable<Parameters<typeof Streamdown>[0]["plugins"]>;

let codePlugin: Promise<Plugins> | undefined;
function loadCodePlugin(): Promise<Plugins> {
  codePlugin ??= new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    .then(() => import("@streamdown/code"))
    .then((module) => ({ code: module.code }) as Plugins);
  return codePlugin;
}

function textOf(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) return children.join("");
  return null;
}

/** A link: a chip when it names something the view knows (a file, a pane, a web page), else a
 *  plain link; web links open outside the view. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const external = typeof href === "string" && /^https?:\/\//i.test(href);
  const plain = (
    <a href={href} className="fl" target={external ? "_blank" : undefined} rel="noreferrer"
      onClick={(event) => { if (!external) event.preventDefault(); }}>
      {children}
    </a>
  );
  if (!href || href.startsWith("#")) return plain;
  const text = textOf(children);
  // A link whose text is its address shows as the chip's own short name.
  const label = text && text !== href && text.replace(/^https?:\/\//, "") !== href.replace(/^https?:\/\//, "") ? children : undefined;
  return <NamedChip name={href.replace(/^file:\/\//, "")} label={label} fallback={plain} />;
}

/** A file the agent named relative to something (`OVERVIEW.md`, `src/main.tsx:42`) keeps the name
 *  it wrote on its chip, without the line, which the chip shows itself; an absolute or ~ path
 *  shows its last parts. */
function writtenLabel(name: string): string | undefined {
  const bare = name.replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, "");
  if (!bare || bare.startsWith("/") || bare.startsWith("~") || bare.startsWith("%") || !/[./]/.test(bare)) return undefined;
  return bare.split("/").length > 3 ? undefined : bare;
}

/** `code` in the text: a chip when it names a file, an image, a pane, a bead or a commit. */
function InlineCode({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
  const text = textOf(children)?.trim();
  const code = <code {...props}>{children}</code>;
  if (!text || text.length > 300 || /\s/.test(text)) return code;
  return <NamedChip name={text} label={writtenLabel(text)} fallback={code} />;
}

/** A path or pane id in the prose (marked by rehypePathRefs): a chip when the host finds it. */
function Span({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown; "data-path-ref"?: string }) {
  const name = props["data-path-ref"];
  if (name === undefined) return <span {...props}>{children}</span>;
  return <NamedChip name={name} label={writtenLabel(name)} fallback={<>{children}</>} />;
}

/** Streamdown marks a fenced block's code with data-block; the rest is inline. */
function Code(props: { children?: ReactNode; className?: string; node?: { properties?: { metastring?: string } } }) {
  return "data-block" in props ? <CodeBlock {...props} /> : <InlineCode>{props.children}</InlineCode>;
}

/** Words fade in as the agent writes them, as in Claude: soft, quick, word by word. */
const STREAMING_FADE = { animation: "fadeIn", duration: 260, easing: "ease-out", sep: "word" as const, stagger: 12 };

const components = { a: Link, inlineCode: InlineCode, code: Code, blockquote: Quote, span: Span } as Parameters<typeof Streamdown>[0]["components"];
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as Parameters<typeof Streamdown>[0]["controls"];

/** Streamdown's own plugins, then the one that finds paths in the prose. */
const rehypePlugins = [...Object.values(defaultRehypePlugins), rehypePathRefs] as Parameters<typeof Streamdown>[0]["rehypePlugins"];

export default function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const [plugins, setPlugins] = useState<Plugins | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadCodePlugin().then((loaded) => { if (!cancelled) setPlugins(loaded); });
    return () => { cancelled = true; };
  }, []);
  return (
    <Streamdown mode={streaming ? "streaming" : "static"} isAnimating={streaming} plugins={plugins}
      animated={streaming ? STREAMING_FADE : false}
      components={components} controls={controls} rehypePlugins={rehypePlugins} linkSafety={{ enabled: false }}>
      {text}
    </Streamdown>
  );
}
