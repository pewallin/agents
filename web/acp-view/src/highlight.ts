// Syntax colours for the review: Shiki, loaded when a review opens (never before the view's first
// paint), with a light and a dark theme in one pass. A line is a list of coloured spans.
export interface Token { content: string; color?: string; dark?: string }
export type Lines = Token[][];

const EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust", swift: "swift",
  kt: "kotlin", java: "java", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", yml: "yaml", yaml: "yaml", toml: "toml",
  html: "html", css: "css", scss: "scss", sql: "sql", php: "php", lua: "lua", vue: "vue", svelte: "svelte",
};

export function languageOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (name === "Dockerfile") return "dockerfile";
  if (name === "Makefile") return "make";
  return EXTENSIONS[name.split(".").pop()?.toLowerCase() ?? ""];
}

type Highlighter = Awaited<ReturnType<typeof import("shiki")["createHighlighter"]>>;
const highlighters = new Map<string, Promise<Highlighter>>();

// The JavaScript regex engine, as Streamdown's code blocks use: the view's CSP allows no WebAssembly.
function highlighterFor(lang: string): Promise<Highlighter> {
  let highlighter = highlighters.get(lang);
  if (!highlighter) {
    highlighter = Promise.all([import("shiki"), import("shiki/engine/javascript")]).then(([shiki, engine]) =>
      shiki.createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: [lang],
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
      }));
    highlighters.set(lang, highlighter);
  }
  return highlighter;
}

export async function highlightLines(code: string, path: string): Promise<Lines | null> {
  const lang = languageOf(path);
  if (!lang || !code) return null;
  const highlighter = await highlighterFor(lang);
  const result = highlighter.codeToTokens(code, { lang: lang as never, themes: { light: "github-light", dark: "github-dark" } });
  return result.tokens.map((line) => line.map((token) => {
    const style = (token.htmlStyle ?? {}) as Record<string, string>;
    return { content: token.content, color: style.color ?? token.color, dark: style["--shiki-dark"] };
  }));
}
