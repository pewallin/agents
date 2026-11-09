// Agent text as markdown: Streamdown, which renders unfinished blocks while a reply streams.
// Code highlighting (Shiki, through @streamdown/code) loads with this module, which the view
// loads beside the session after its first paint, and is shared by every message.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
// The fade-in of words as a reply streams (Streamdown's animate plugin and its keyframes).
import "streamdown/styles.css";
import { CodeBlock, Quote } from "./blocks";
import { Chip, NamedChip } from "./chips";
import { rehypeFileLinks, rehypePathRefs } from "./paths";
import { rehypeTicketLinks, useTicketRules, type TicketRule } from "./tickets";

type Plugins = NonNullable<Parameters<typeof Streamdown>[0]["plugins"]>;

const codePlugin: Promise<Plugins | undefined> = import("@streamdown/code")
  .then((module) => ({ code: module.code }) as Plugins, () => undefined);
let loadedPlugins: Plugins | undefined;
/** Resolves once code highlighting is there: a conversation shown after it has its code blocks
 *  in their final form from the first frame. */
export const ready: Promise<void> = codePlugin.then((plugins) => { loadedPlugins = plugins; });

function textOf(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) return children.join("");
  return null;
}

/** A link: a chip when it names something the view knows (a file, a pane, a web page), else a
 *  plain link; web links open outside the view. */
function Link({ href, children, "data-ticket": ticket }: { href?: string; children?: ReactNode; "data-ticket"?: string }) {
  const external = typeof href === "string" && /^https?:\/\//i.test(href);
  // A ticket id (rehypeTicketLinks) is the ticket's chip, with the id as the text has it.
  if (ticket && href && external) return <Chip target={{ kind: "ticket", id: ticket, url: href }} label={children} />;
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

/** A path or pane id in the prose (marked by rehypePathRefs), or a link to a file (rehypeFileLinks,
 *  which keeps the link's text): a chip when the host finds it. */
function Span({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown; "data-path-ref"?: string; "data-path-link"?: string }) {
  const name = props["data-path-ref"];
  if (name === undefined) return <span {...props}>{children}</span>;
  const text = textOf(children);
  const label = props["data-path-link"] !== undefined && text !== name ? children : writtenLabel(name);
  return <NamedChip name={name} label={label} fallback={<>{children}</>} />;
}

/** Streamdown marks a fenced block's code with data-block; the rest is inline. */
function Code(props: { children?: ReactNode; className?: string; node?: { properties?: { metastring?: string } } }) {
  return "data-block" in props ? <CodeBlock {...props} /> : <InlineCode>{props.children}</InlineCode>;
}

/** Words fade in as the agent writes them, as in Claude: soft, quick, word by word. */
const STREAMING_FADE = { animation: "fadeIn", duration: 260, easing: "ease-out", sep: "word" as const, stagger: 12 };

const components = { a: Link, inlineCode: InlineCode, code: Code, blockquote: Quote, span: Span } as Parameters<typeof Streamdown>[0]["components"];
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as Parameters<typeof Streamdown>[0]["controls"];

/** Streamdown's own plugins with links to files kept: the sanitizer lets file: links through, and
 *  they and links with no scheme become file chips before the link filter, which lets web links
 *  alone through. Then the one that finds paths in the prose. */
const [sanitize, sanitizeSchema] = defaultRehypePlugins.sanitize as unknown as [unknown, { protocols?: Record<string, string[]> }];
/** Ticket ids (rehypeTicketLinks) become links after the link filter, to the addresses of the
 *  user's own rules alone, and before the paths, so an id is not taken for one. */
const rehypePlugins = (tickets: readonly TicketRule[]) => [
  defaultRehypePlugins.raw,
  [sanitize, { ...sanitizeSchema, protocols: { ...sanitizeSchema.protocols, href: [...(sanitizeSchema.protocols?.href ?? []), "file"] } }],
  rehypeFileLinks,
  defaultRehypePlugins.harden,
  rehypeTicketLinks(tickets),
  rehypePathRefs,
] as Parameters<typeof Streamdown>[0]["rehypePlugins"];

/** `streaming`: the text is still coming (Streamdown's streaming mode); `fade`: its new words
 *  fade in (by default while it streams). */
export default function Markdown({ text, streaming, fade = streaming }: { text: string; streaming: boolean; fade?: boolean }) {
  const [plugins, setPlugins] = useState<Plugins | undefined>(() => loadedPlugins);
  const tickets = useTicketRules();
  const rehype = useMemo(() => rehypePlugins(tickets), [tickets]);
  useEffect(() => {
    if (plugins) return;
    let cancelled = false;
    void codePlugin.then((loaded) => { if (!cancelled) setPlugins(loaded); });
    return () => { cancelled = true; };
  }, [plugins]);
  return (
    <Streamdown mode={streaming ? "streaming" : "static"} isAnimating={streaming} plugins={plugins}
      animated={fade ? STREAMING_FADE : false}
      components={components} controls={controls} rehypePlugins={rehype} linkSafety={{ enabled: false }}>
      {text}
    </Streamdown>
  );
}
