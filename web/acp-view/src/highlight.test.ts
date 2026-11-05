import { describe, expect, it } from "vitest";
import { highlightLines, languageOf } from "./highlight";

describe("languageOf", () => {
  it("knows a file's language by its name", () => {
    expect(languageOf("/x/fib.py")).toBe("python");
    expect(languageOf("src/App.TSX")).toBe("tsx");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes.unknownext")).toBeUndefined();
  });
});

describe("highlightLines", () => {
  it("colours each line for both themes", async () => {
    const lines = await highlightLines("def f():\n    return 1", "a.py");
    expect(lines).toHaveLength(2);
    const def = lines![0].find((token) => token.content === "def");
    expect(def?.color).toMatch(/^#/);
    expect(def?.dark).toMatch(/^#/);
  });

  it("leaves unknown languages plain", async () => {
    expect(await highlightLines("x", "a.unknownext")).toBeNull();
  });
});
