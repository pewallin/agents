// Agent text as markdown: Streamdown, which renders unfinished blocks while a reply streams.
// Code highlighting (Shiki, through @streamdown/code) is loaded after the first paint and then
// shared by every message.
import { useEffect, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { NamedChip } from "./chips";

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

/** `code` in the text: a chip when it names a file, an image, a pane, a bead or a commit. */
function InlineCode({ children, ...props }: { children?: ReactNode }) {
  const text = textOf(children)?.trim();
  const code = <code {...props}>{children}</code>;
  if (!text || text.length > 300 || /\s/.test(text)) return code;
  return <NamedChip name={text} fallback={code} />;
}

const components = { a: Link, inlineCode: InlineCode } as Parameters<typeof Streamdown>[0]["components"];
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as Parameters<typeof Streamdown>[0]["controls"];

export default function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const [plugins, setPlugins] = useState<Plugins | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadCodePlugin().then((loaded) => { if (!cancelled) setPlugins(loaded); });
    return () => { cancelled = true; };
  }, []);
  return (
    <Streamdown mode={streaming ? "streaming" : "static"} isAnimating={streaming} plugins={plugins}
      components={components} controls={controls} linkSafety={{ enabled: false }}>
      {text}
    </Streamdown>
  );
}
