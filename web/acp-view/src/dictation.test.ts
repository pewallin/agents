import { describe, expect, it } from "vitest";
import { withDictation } from "./dictation";

describe("dictation into the field", () => {
  it("goes after what is there, a space between", () => {
    expect(withDictation("", " Fix the build ")).toBe("Fix the build");
    expect(withDictation("Look at", "the tests")).toBe("Look at the tests");
    expect(withDictation("First line\n", "second")).toBe("First line\nsecond");
    expect(withDictation("Keep", "  ")).toBe("Keep");
  });
});
