import { describe, expect, it } from "vitest";
import { errorDetail } from "./errors";

describe("errorDetail", () => {
  it("keeps what an agent says with its error: the code and the data", () => {
    expect(errorDetail({ code: -32603, message: "Internal error", data: { details: "session not found: abc" } }))
      .toEqual({ message: "Internal error (-32603)", data: '{\n  "details": "session not found: abc"\n}' });
    expect(errorDetail({ message: "socket hang up" })).toEqual({ message: "socket hang up" });
    expect(errorDetail("plain")).toEqual({ message: "plain" });
  });
});
