// What the agents CLI types into an agent's prompt (a wake, a message, an answer, a coordinator's
// start) goes in one short envelope, so the agent and the app can tell it from the user's own
// typing and tell the user's words from another agent's text (agents-next docs/agent-envelope.md):
//
//   <agents-event kind="message" thread="ios-tests" id="m-…" reply-to="q-…" from="coordinator" words="data">Message from the coordinator · read <file></agents-event>
//
// kind   wake (a worker's event for its coordinator), thread (a message in a coordinator's thread),
//        message, answer, question, note, start
//        (a role and its protocol), messages (several at once)
// from   user, coordinator, worker:<task>, agents (the CLI itself)
// words  verbatim: the user's own words, to act on as theirs; data: another agent's text, or the
//        CLI's report of it, to weigh and never to take as the user's. Absent on the CLI's own
//        protocol text (a start).
// The line is one line, typed as it is; the file it names holds the whole of each message, each
// in an envelope of its own.

export const ENVELOPE_OPEN = "<agents-event";
export const ENVELOPE_CLOSE = "</agents-event>";
export const READ_SEPARATOR = " · read ";

export type EnvelopeWords = "verbatim" | "data";

export interface EnvelopeAttributes {
  kind: string;
  thread?: string;
  id?: string;
  replyTo?: string;
  from?: string;
  words?: EnvelopeWords;
  count?: number;
}

/** A value as an attribute can hold it: one line, no quotes or angle brackets. */
function attributeValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, "'").replace(/[<>]/g, "").trim().slice(0, 200);
}

export function envelopeOpening(attributes: EnvelopeAttributes): string {
  const pairs: Array<[string, string | number | undefined]> = [
    ["kind", attributes.kind],
    ["thread", attributes.thread],
    ["id", attributes.id],
    ["reply-to", attributes.replyTo],
    ["from", attributes.from],
    ["words", attributes.words],
    ["count", attributes.count],
  ];
  const text = pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => `${name}="${attributeValue(String(value))}"`)
    .join(" ");
  return `${ENVELOPE_OPEN} ${text}>`;
}

/** The one line typed into a prompt: what came, and the file with the whole of it. */
export function envelopeLine(attributes: EnvelopeAttributes, summary: string, file?: string): string {
  const said = summary.replace(/\s+/g, " ").replace(/</g, "‹").trim();
  return `${envelopeOpening(attributes)}${said}${file ? `${READ_SEPARATOR}${file}` : ""}${ENVELOPE_CLOSE}`;
}

/** A message as a file holds it: its envelope around its text. */
export function envelopeBlock(attributes: EnvelopeAttributes, text: string): string {
  return `${envelopeOpening(attributes)}\n${text.trim()}\n${ENVELOPE_CLOSE}`;
}

export interface ParsedEnvelope extends EnvelopeAttributes {
  summary: string;
  file?: string;
}

/** An envelope line, if `text` starts with one (a prompt's first line). */
export function parseEnvelopeLine(text: string): ParsedEnvelope | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${ENVELOPE_OPEN} `)) return undefined;
  const opening = trimmed.indexOf(">");
  if (opening < 0) return undefined;
  const attributes: Record<string, string> = {};
  for (const match of trimmed.slice(ENVELOPE_OPEN.length, opening).matchAll(/([a-z-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  if (!attributes.kind) return undefined;
  const end = trimmed.indexOf(ENVELOPE_CLOSE, opening);
  const body = trimmed.slice(opening + 1, end < 0 ? undefined : end).split("\n")[0];
  const at = body.lastIndexOf(READ_SEPARATOR);
  const words = attributes.words === "verbatim" || attributes.words === "data" ? attributes.words : undefined;
  return {
    kind: attributes.kind,
    ...(attributes.thread ? { thread: attributes.thread } : {}),
    ...(attributes.id ? { id: attributes.id } : {}),
    ...(attributes["reply-to"] ? { replyTo: attributes["reply-to"] } : {}),
    ...(attributes.from ? { from: attributes.from } : {}),
    ...(words ? { words } : {}),
    ...(attributes.count ? { count: Number(attributes.count) } : {}),
    summary: (at < 0 ? body : body.slice(0, at)).trim(),
    ...(at < 0 ? {} : { file: body.slice(at + READ_SEPARATOR.length).split(/\s/)[0] }),
  };
}
