import { describe, expect, it } from "vitest";
import { quoted } from "./compose";

describe("quoted", () => {
  it("quotes each line of the selection below the draft", () => {
    expect(quoted("first\nsecond\n", "")).toBe("> first\n> second\n\n");
    expect(quoted("a\n\nb", "Look here  ")).toBe("Look here\n\n> a\n>\n> b\n\n");
  });

  it("leaves the draft alone for an empty selection", () => {
    expect(quoted("  \n", "draft")).toBe("draft");
  });
});
