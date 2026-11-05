// Agent text as markdown: Streamdown, which renders unfinished blocks while a reply streams.
// Code highlighting (Shiki, through @streamdown/code) is loaded after the first paint and then
// shared by every message.
import { useEffect, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";

type Plugins = NonNullable<Parameters<typeof Streamdown>[0]["plugins"]>;

let codePlugin: Promise<Plugins> | undefined;
function loadCodePlugin(): Promise<Plugins> {
  codePlugin ??= new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    .then(() => import("@streamdown/code"))
    .then((module) => ({ code: module.code }) as Plugins);
  return codePlugin;
}

/** Web links open outside the view; other targets (files the agent names) stay put until the
 *  app can open them in a pane. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const external = typeof href === "string" && /^https?:\/\//i.test(href);
  return (
    <a href={href} className="fl" target={external ? "_blank" : undefined} rel="noreferrer"
      onClick={(event) => { if (!external) event.preventDefault(); }}>
      {children}
    </a>
  );
}

const components = { a: Link } as Parameters<typeof Streamdown>[0]["components"];
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
