/**
 * Minimal edits of JSON text: one member of an object, or one element of an array, put in or
 * taken out, with every other byte of the file as it was. Setup uses it on the harnesses' own
 * config files, which users format by hand, so that uninstall gives the file back byte for byte.
 */

interface Value {
  kind: "object" | "array" | "scalar";
  start: number;
  end: number;
  members?: Member[];
  elements?: Value[];
  /** For a string scalar, its value. */
  text?: string;
}

interface Member {
  key: string;
  keyStart: number;
  value: Value;
}

class Parser {
  index = 0;
  constructor(private readonly source: string) {}

  fail(message: string): never {
    throw new Error(`${message} at offset ${this.index}`);
  }

  space(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index += 1;
  }

  value(): Value {
    this.space();
    const start = this.index;
    const char = this.source[this.index];
    if (char === "{") return this.object(start);
    if (char === "[") return this.array(start);
    if (char === "\"") {
      const text = this.string();
      return { kind: "scalar", start, end: this.index, text };
    }
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.source.slice(this.index));
    if (!match) this.fail("unexpected character");
    this.index += match[0].length;
    return { kind: "scalar", start, end: this.index };
  }

  string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length && this.source[this.index] !== "\"") {
      this.index += this.source[this.index] === "\\" ? 2 : 1;
    }
    if (this.source[this.index] !== "\"") this.fail("unterminated string");
    this.index += 1;
    return JSON.parse(this.source.slice(start, this.index));
  }

  object(start: number): Value {
    this.index += 1;
    const members: Member[] = [];
    this.space();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return { kind: "object", start, end: this.index, members };
    }
    for (;;) {
      this.space();
      if (this.source[this.index] !== "\"") this.fail("expected a key");
      const keyStart = this.index;
      const key = this.string();
      this.space();
      if (this.source[this.index] !== ":") this.fail("expected ':'");
      this.index += 1;
      members.push({ key, keyStart, value: this.value() });
      this.space();
      if (this.source[this.index] === ",") { this.index += 1; continue; }
      if (this.source[this.index] === "}") { this.index += 1; return { kind: "object", start, end: this.index, members }; }
      this.fail("expected ',' or '}'");
    }
  }

  array(start: number): Value {
    this.index += 1;
    const elements: Value[] = [];
    this.space();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return { kind: "array", start, end: this.index, elements };
    }
    for (;;) {
      elements.push(this.value());
      this.space();
      if (this.source[this.index] === ",") { this.index += 1; continue; }
      if (this.source[this.index] === "]") { this.index += 1; return { kind: "array", start, end: this.index, elements }; }
      this.fail("expected ',' or ']'");
    }
  }
}

export function parseJsonText(text: string): Value {
  const parser = new Parser(text);
  const root = parser.value();
  parser.space();
  if (parser.index !== text.length) parser.fail("trailing characters");
  return root;
}

function find(root: Value, path: string[]): Value | undefined {
  let current: Value | undefined = root;
  for (const key of path) {
    if (current?.kind !== "object") return undefined;
    current = current.members!.find((member) => member.key === key)?.value;
  }
  return current;
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** The file's indentation unit: the indent of the first indented line, two spaces by default. */
function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
}

function render(value: unknown, indent: string, unit: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(`\n${indent}`);
}

/** Puts `"key": value` as the last member of the object at `path`, creating the objects on the
 *  way that are missing (each as the last member of its parent). */
export function insertMember(text: string, path: string[], key: string, value: unknown): string {
  const root = parseJsonText(text);
  if (root.kind !== "object") throw new Error("the file is not a JSON object");
  let depth = 0;
  let holder = root;
  while (depth < path.length) {
    const next = find(holder, [path[depth]]);
    if (!next) break;
    if (next.kind !== "object") throw new Error(`${path.slice(0, depth + 1).join(".")} is not an object`);
    holder = next;
    depth += 1;
  }
  // Whatever is missing goes in as one nested value.
  let inserted: unknown = value;
  for (let index = path.length - 1; index >= depth; index -= 1) inserted = { [index === path.length - 1 ? key : path[index + 1]]: inserted };
  const memberKey = depth < path.length ? path[depth] : key;
  const unit = indentUnit(text);
  const members = holder.members!;
  if (members.length === 0) {
    const outer = lineIndent(text, holder.start);
    const indent = outer + unit;
    return `${text.slice(0, holder.start)}{\n${indent}${JSON.stringify(memberKey)}: ${render(inserted, indent, unit)}\n${outer}}${text.slice(holder.end)}`;
  }
  const last = members[members.length - 1];
  const multiline = text.slice(holder.start, last.keyStart).includes("\n");
  const indent = multiline ? lineIndent(text, last.keyStart) : "";
  const separator = multiline ? `,\n${indent}` : ", ";
  const member = `${JSON.stringify(memberKey)}: ${render(inserted, multiline ? indent : "", multiline ? unit : "")}`;
  return `${text.slice(0, last.value.end)}${separator}${member}${text.slice(last.value.end)}`;
}

/** Takes the member `key` out of the object at `path`, with the separator it brought; an object
 *  left with no members is written `{}`. */
export function removeMember(text: string, path: string[], key: string): string {
  const root = parseJsonText(text);
  const holder = find(root, path);
  if (holder?.kind !== "object") return text;
  const members = holder.members!;
  const index = members.findIndex((member) => member.key === key);
  if (index < 0) return text;
  const member = members[index];
  if (members.length === 1) {
    return `${text.slice(0, holder.start)}{}${text.slice(holder.end)}`;
  }
  if (index > 0) {
    // From the end of the member before it.
    return `${text.slice(0, members[index - 1].value.end)}${text.slice(member.value.end)}`;
  }
  // The first of several: up to the key of the next.
  return `${text.slice(0, member.keyStart)}${text.slice(members[1].keyStart)}`;
}

/** Appends a string element to the array at `path`. */
export function appendElement(text: string, path: string[], element: string): string {
  const root = parseJsonText(text);
  const array = find(root, path);
  if (array?.kind !== "array") throw new Error(`${path.join(".")} is not an array`);
  const elements = array.elements!;
  if (elements.length === 0) return `${text.slice(0, array.start)}[${JSON.stringify(element)}]${text.slice(array.end)}`;
  const last = elements[elements.length - 1];
  const multiline = text.slice(array.start, last.start).includes("\n");
  const separator = multiline ? `,\n${lineIndent(text, last.start)}` : ", ";
  return `${text.slice(0, last.end)}${separator}${JSON.stringify(element)}${text.slice(last.end)}`;
}

/** Takes a string element out of the array at `path`, with the separator it brought. */
export function removeElement(text: string, path: string[], element: string): string {
  const root = parseJsonText(text);
  const array = find(root, path);
  if (array?.kind !== "array") return text;
  const elements = array.elements!;
  const index = elements.findIndex((item) => item.text === element);
  if (index < 0) return text;
  if (elements.length === 1) return `${text.slice(0, array.start)}[]${text.slice(array.end)}`;
  if (index > 0) return `${text.slice(0, elements[index - 1].end)}${text.slice(elements[index].end)}`;
  return `${text.slice(0, elements[0].start)}${text.slice(elements[1].start)}`;
}
