import { describe, expect, it } from "vitest";
import { startsFolded } from "./fold";

describe("the fold of a pane's line and prompt", () => {
  it("starts folded in a small pane, as in a grid", () => {
    expect(startsFolded(380, 700)).toBe(true);
    expect(startsFolded(900, 300)).toBe(true);
    expect(startsFolded(900, 700)).toBe(false);
  });

  it("does not fold a page that has no size yet", () => {
    expect(startsFolded(0, 0)).toBe(false);
  });
});
