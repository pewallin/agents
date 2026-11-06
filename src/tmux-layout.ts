// tmux window layouts in the classic format ("csum,WxH,X,Y{...}"). tmux 3.8 reports a JSON
// layout ({"V":2,"L":{...}}) in #{window_layout}; every tmux takes the classic one in
// select-layout (3.8 still does), and the code that reads pane ids out of a layout reads it.

interface JsonNode {
  t?: string;
  w?: number;
  h?: number;
  x?: number;
  y?: number;
  I?: string | number;
  c?: JsonNode[];
}

function checksum(body: string): string {
  let sum = 0;
  for (const byte of Buffer.from(body, "utf8")) {
    sum = ((sum >> 1) | ((sum & 1) << 15)) & 0xffff;
    sum = (sum + byte) & 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

function write(node: JsonNode, depth: number): string | undefined {
  const { t, w, h } = node;
  if (depth > 64 || !Number.isInteger(w) || !Number.isInteger(h)) return undefined;
  const head = `${w}x${h},${node.x ?? 0},${node.y ?? 0}`;
  if (t === "p") {
    const id = String(node.I ?? "").replace(/^%/, "");
    return /^\d+$/.test(id) ? `${head},${id}` : undefined;
  }
  if ((t !== "h" && t !== "v") || !Array.isArray(node.c) || node.c.length < 2) return undefined;
  const children = node.c.map((child) => write(child, depth + 1));
  if (children.some((child) => child === undefined)) return undefined;
  return t === "h" ? `${head}{${children.join(",")}}` : `${head}[${children.join(",")}]`;
}

/** A layout as tmux reported it, in the classic format; one that does not convert as it came. */
export function classicLayout(reported: string): string {
  const trimmed = reported.trim();
  if (!trimmed.startsWith("{")) return reported;
  try {
    const parsed = JSON.parse(trimmed) as { L?: JsonNode };
    const body = parsed.L ? write(parsed.L, 0) : undefined;
    return body ? `${checksum(body)},${body}` : reported;
  } catch {
    return reported;
  }
}
