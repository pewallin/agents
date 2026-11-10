import { describe, expect, it } from "vitest";
import { contextPercent, costText, tokenText, usageText, usageTitle } from "./usage";

describe("usage", () => {
  it("writes tokens as the pane's header does", () => {
    expect(tokenText(840)).toBe("840");
    expect(tokenText(43_210)).toBe("43k");
    expect(tokenText(1_250_000)).toBe("1.3M");
  });

  it("writes dollars, Kiro credits and Copilot AIU", () => {
    expect(costText({ amount: 0.4237, currency: "USD" })).toBe("$0.42");
    expect(costText({ amount: 12.6, currency: "USD" })).toBe("$13");
    expect(costText({ amount: 1.34, currency: "credits" })).toBe("1.3 cr");
    expect(costText({ amount: 312.4, currency: "AIU" })).toBe("312 AIU");
    expect(costText({ amount: 2, currency: "" })).toBe("2");
  });

  it("shows the context and the spend, or what of them is known", () => {
    expect(usageText({ used: 43_210, size: 200_000, cost: { amount: 0.42, currency: "USD" } })).toBe("43k · $0.42");
    expect(usageText({ used: 43_210, size: 200_000 })).toBe("43k");
    expect(usageText({ used: 0, size: 0, cost: { amount: 1.34, currency: "credits" } })).toBe("1.3 cr");
    expect(contextPercent({ used: 0, size: 0 })).toBeUndefined();
    expect(usageText({ used: 0, size: 0 })).toBe("");
  });

  it("says the exact figures on hover", () => {
    expect(usageTitle({ used: 43_210, size: 200_000, cost: { amount: 0.42, currency: "USD" } }))
      .toBe("Context: 43,210 of 200,000 tokens (22 %)\nSession spend: $0.42");
  });
});
