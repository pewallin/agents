import { describe, expect, it } from "vitest";
import { threadOfPageOptions } from "./send.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("a pane that shows a thread beside the user", () => {
  it("is that thread when it shows the thread's page or a terminal thread's", () => {
    const view = encode({ surface: { web: { url: "http://127.0.0.1:4100/thread/s1?agents-next=acp-page&mirror=1&task=wi01-dts&program=%2Fh%2Fp#token=x" } } });
    expect(threadOfPageOptions(["", view])).toEqual({ task: "wi01-dts", program: "/h/p" });
    const page = encode({ source: {}, url: "http://127.0.0.1:4100/worker?agents-next=acp-page&task=wi29-models&program=%2Fh%2Fp" });
    expect(threadOfPageOptions([page, ""])).toEqual({ task: "wi29-models", program: "/h/p" });
    // As the app writes it: Swift's JSON escapes every slash.
    const swift = Buffer.from(JSON.stringify({ url: "http://127.0.0.1:4100/thread/s1?mirror=1&task=wi01-dts&program=%2Fh%2Fp" }).replace(/\//g, "\\/")).toString("base64");
    expect(threadOfPageOptions([swift])).toEqual({ task: "wi01-dts", program: "/h/p" });
  });

  it("is no thread for any other page or a shell", () => {
    expect(threadOfPageOptions(["", ""])).toBeUndefined();
    expect(threadOfPageOptions([encode({ url: "http://127.0.0.1:4100/threads?program=%2Fh%2Fp" })])).toBeUndefined();
    expect(threadOfPageOptions([encode({ url: "https://example.com/?task=a&program=b&mirror=1" })])).toBeUndefined();
  });
});
