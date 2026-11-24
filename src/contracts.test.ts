// The JSON Agents Next decodes from this CLI, held to the schemas in contracts/. The app keeps
// the same files and decodes the examples with its own types, and a release refuses to bundle a
// CLI whose contracts/ differs from the app's: rename or retype a field here and this test, the
// app's, or the release says so.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec } from "./shell.js";
import { appendRuntimeFocusRequest, appendRuntimeStateEvent } from "./runtime-events.js";
import { listDoneProjection, recordDoneEvent, updateDoneProjection } from "./done.js";
import { reportState } from "./state.js";
import { getSessionHistory, scan } from "./scanner.js";

// tmux, ps and git answer from the test.
vi.mock(import("./shell.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(() => ""),
  gitBranch: vi.fn(() => "main"),
}));

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  $ref?: string;
  $defs?: Record<string, Schema>;
};

function readSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(contractsDir, `${name}.schema.json`), "utf8"));
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The part of JSON Schema the contracts use; anything else in a schema is an error, so the
 *  check never passes by ignoring a keyword. */
function validate(value: unknown, schema: Schema, root: Schema, path = "$"): string[] {
  const known = new Set(["$schema", "title", "description", "type", "const", "enum", "pattern", "properties", "required", "additionalProperties", "items", "$ref", "$defs"]);
  const unknownKeyword = Object.keys(schema).find((key) => !known.has(key));
  if (unknownKeyword) return [`${path}: schema keyword ${unknownKeyword} is not supported`];
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    return target ? validate(value, target, root, path) : [`${path}: unknown $ref ${schema.$ref}`];
  }
  const errors: string[] = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      return [`${path}: ${actual}, expected ${types.join(" or ")}`];
    }
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: ${JSON.stringify(value)}, expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: ${value} does not match ${schema.pattern}`);
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...validate(item, schema.items!, root, `${path}[${index}]`)));
  }
  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${path}: missing ${key}`);
    }
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validate(item, property, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: ${key} is not in the schema`);
    }
  }
  return errors;
}

/** Every property path the schema names, and every one the values carry. */
function propertyPaths(schema: Schema, root: Schema, path = "$", into = new Set<string>()): Set<string> {
  if (schema.$ref) return propertyPaths(root.$defs![schema.$ref.replace(/^#\/\$defs\//, "")], root, path, into);
  if (schema.items) propertyPaths(schema.items, root, `${path}[]`, into);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    into.add(`${path}.${key}`);
    propertyPaths(property, root, `${path}.${key}`, into);
  }
  return into;
}

function valuePaths(value: unknown, path = "$", into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => valuePaths(item, `${path}[]`, into));
  else if (typeOf(value) === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      into.add(`${path}.${key}`);
      valuePaths(item, `${path}.${key}`, into);
    }
  }
  return into;
}

function expectValid(value: unknown, schema: Schema): void {
  expect(validate(value, schema, schema)).toEqual([]);
}

function readExample(name: string): unknown[] {
  const file = readdirSync(contractsDir).find((entry) => entry.startsWith(`${name}.example.`))!;
  const text = readFileSync(join(contractsDir, file), "utf8");
  return file.endsWith(".jsonl") ? text.trim().split("\n").map((line) => JSON.parse(line)) : [JSON.parse(text)];
}

const contracts = readdirSync(contractsDir)
  .filter((entry) => entry.endsWith(".schema.json"))
  .map((entry) => entry.replace(/\.schema\.json$/, ""));

describe("contracts", () => {
  it("has the four the app reads", () => {
    expect(contracts.sort()).toEqual(["done", "history", "ls", "runtime-state-event"]);
  });

  for (const name of contracts) {
    it(`${name}: the example fits the schema and shows every field it names`, () => {
      const schema = readSchema(name);
      const examples = readExample(name);
      for (const example of examples) expectValid(example, schema);
      const shown = new Set<string>();
      for (const example of examples) valuePaths(example, "$", shown);
      expect([...propertyPaths(schema, schema)].filter((path) => !shown.has(path))).toEqual([]);
    });
  }
});

describe("what the CLI writes fits the contracts", () => {
  let directory: string;
  const environment = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => {
    if (!environment.has(key)) environment.set(key, process.env[key]);
    process.env[key] = value;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agents-contracts-"));
  });

  afterEach(() => {
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    environment.clear();
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockReturnValue("");
    rmSync(directory, { recursive: true, force: true });
  });

  it("state events", () => {
    const eventPath = join(directory, "state-events.jsonl");
    setEnv("AGENTS_RUNTIME_STATE_EVENTS_PATH", eventPath);
    appendRuntimeStateEvent("primary_state", "upsert", "codex", "%3", {
      reporter: "codex-hook",
      state: "working",
      intent: "Run focused tests",
      responsePreview: "Implemented the fix.",
      detail: "npm test",
      externalSessionId: "thread-1",
      stateSource: "primary",
      auxiliaryReporters: ["acp"],
      activity: true,
    });
    appendRuntimeStateEvent("contributor_state", "upsert", "claude", "%5", {
      state: "approval",
      stateSource: "contributor",
      primaryState: "working",
      clearIntent: true,
      clearResponsePreview: true,
    });
    appendRuntimeStateEvent("primary_state", "remove", "claude", "%4", { activity: false });
    appendRuntimeFocusRequest("%7");

    const schema = readSchema("runtime-state-event");
    const lines = readFileSync(eventPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expectValid(JSON.parse(line), schema);
  });

  it("done list, record and update", () => {
    setEnv("AGENTS_DONE_STORE_PATH", join(directory, "done.json"));
    const schema = readSchema("done");
    expectValid(recordDoneEvent({
      contractVersion: 1,
      sessionIdentity: "external-session-1",
      hostID: "local",
      tmux: { session: "work", window: "@2", pane: "%3" },
      agentKind: "codex",
      externalSessionID: "external-session-1",
      title: "Fix the login flow",
      detail: "Tests pass",
      statusSnapshot: "idle",
      createdAt: "2026-06-22T00:00:00.123Z",
    }), schema);
    expectValid(recordDoneEvent({
      sessionIdentity: "pane-4",
      hostID: "local",
      tmux: { pane: "%4" },
      agentKind: "pi",
      title: "Pi",
      statusSnapshot: "attention",
      createdAt: "2026-06-22T00:01:00Z",
    }), schema);
    expectValid(updateDoneProjection({ sessionIdentity: "external-session-1", pin: true }), schema);
    const projection = listDoneProjection();
    expect(projection.records).toHaveLength(2);
    expect(projection.pinnedSessions).toHaveLength(1);
    expectValid(projection, schema);
  });

  it("ls", () => {
    // One tmux pane whose shell runs Pi, with the state Pi's hooks reported.
    const fields = ["work:agents.0", "10", "Fix the login flow", "agents", "pi", "1779118660", "/dev/ttys011", "work:1", "%3", directory, "", "", "", "0", ""];
    vi.mocked(exec).mockImplementation((command: string) => {
      if (command.startsWith("tmux list-panes")) return `${fields.join("\u001f")}\u001e`;
      if (command.startsWith("ps ")) {
        return [
          "10 1 01:00 zsh ttys011 0.0 1024 -zsh",
          "11 10 00:30 pi ttys011 3.5 409700 pi",
        ].join("\n");
      }
      return "";
    });
    reportState("pi", "%3", "working", {
      intent: "Run focused tests",
      responsePreview: "Implemented the fix.",
      detail: "npm test",
      externalSessionId: "pi-session-1",
      context: "compacting",
      contextTokens: 81234,
      contextMax: 272000,
      spend: 1.25,
      spendUnit: "USD",
      provider: "anthropic",
      modelId: "claude-opus",
      modelLabel: "Opus",
    });

    const panes = scan();
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({ tmuxPaneId: "%3", agent: "pi", status: "working" });
    expectValid(panes, readSchema("ls"));
  });

  it("history", () => {
    // A Claude Code conversation in a folder, as Claude Code writes its transcript.
    setEnv("HOME", directory);
    const cwd = join(directory, "app");
    mkdirSync(cwd);
    const projectDir = join(directory, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "conversation-1.jsonl"), [
      { type: "user", sessionId: "conversation-1", cwd, timestamp: "2026-06-22T00:00:00Z", message: { role: "user", content: "Fix the login flow and add a test" } },
      { type: "assistant", sessionId: "conversation-1", cwd, timestamp: "2026-06-22T00:01:00Z", message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "Done." }] } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");

    const groups = getSessionHistory({ agent: "claude", cwd, limit: 5 });
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual(["conversation-1"]);
    expectValid(groups, readSchema("history"));
  });
});
