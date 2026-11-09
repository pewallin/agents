import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyTicketLook, ticketRules, ticketTokens, typedTicketTokens, type TicketRule } from "./tickets";

const jira: TicketRule = { prefix: "TH-", digits: 4, url: "https://jira.example.com/browse/{id}" };

describe("ticket ids in prose", () => {
  it("takes only well-formed rules from the look", () => {
    expect(ticketRules(undefined)).toEqual([]);
    expect(ticketRules({ tickets: "x" })).toEqual([]);
    expect(ticketRules({ tickets: [
      { prefix: "TH-", digits: 4, url: "https://jira.example.com/browse/{id}" },
      { prefix: "OPS-", digits: null, url: "https://t.example/{number}" },
      { prefix: "BAD-", digits: 2, url: "javascript:alert('{id}')" },
      { prefix: "NOID-", digits: 2, url: "https://t.example/" },
      { prefix: "", digits: 2, url: "https://t.example/{id}" },
    ] })).toEqual([jira, { prefix: "OPS-", digits: null, url: "https://t.example/{number}" }]);
  });

  it("links an id as a word of its own, with its digits limit", () => {
    const ids = (text: string) => ticketTokens(text, [jira]).map((token) => token.id);
    expect(ids("Fixed TH-3826 and (TH-12), see TH-7.")).toEqual(["TH-3826", "TH-12", "TH-7"]);
    expect(ids("th-3826 too")).toEqual(["TH-3826"]);
    expect(ids("TH-12345 MATH-12 TH-12-fix src/TH-12 TH-12.md TH-12x TH-")).toEqual([]);
    expect(ticketTokens("TH-3826", [jira])[0].href).toBe("https://jira.example.com/browse/TH-3826");
    expect(ticketTokens("ops-5", [{ prefix: "OPS-", digits: null, url: "https://t.example/{number}?k={id}" }])[0].href).toBe("https://t.example/5?k=OPS-5");
  });

  it("leaves ids in code alone in what you typed", () => {
    expect(typedTicketTokens("TH-1 `TH-2` ```\nTH-3\n``` TH-4", [jira]).map((token) => token.id)).toEqual(["TH-1", "TH-4"]);
  });
});

describe("ticket ids in the agent's text", () => {
  it("become links in prose, not in code or links", async () => {
    applyTicketLook({ tickets: [jira] });
    const { default: Markdown } = await import("./markdown");
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: "Done with TH-3826.\n\n`TH-1111` and [the ticket](https://example.com/x) TH-2222\n\n```\nTH-3333\n```",
      streaming: false,
    }));
    expect(html).toContain('href="https://jira.example.com/browse/TH-3826"');
    expect(html).toContain('href="https://jira.example.com/browse/TH-2222"');
    expect(html).not.toContain("browse/TH-1111");
    expect(html).not.toContain("browse/TH-3333");
    applyTicketLook({ tickets: [] });
  });
});
