import { describe, expect, it } from "vitest";
import { rowsFromListing, shortAge, splitRows } from "./threads-list";

describe("the Threads tab's rows", () => {
  it("reads the host's listing in the rows' words when the app does not feed the page", () => {
    const list = rowsFromListing({ name: "Shop", threads: [
      { task: "a", title: "A", state: "needs-you", updatedAt: "2026-11-28T10:00:00Z", line: "Which bucket?", pane: "%1" },
      { task: "b", title: "", state: "done", updatedAt: "2026-11-28T10:00:00Z", pane: "%2" },
      { task: "c", title: "C", state: "resolved", resolvedAt: "2026-11-28T11:00:00Z", pane: "%3" },
    ] }, "/p");
    expect(list.threads.map((row) => row.mark)).toEqual(["waits", "idle", "resolved"]);
    expect(list.threads[1].title).toBe("b");
    // A resolved thread has no tab to go to.
    expect(list.threads[2].pane).toBeUndefined();
    expect(splitRows(list.threads).resolved.map((row) => row.task)).toEqual(["c"]);
  });

  it("says a row's age as the app's rows do", () => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    expect(shortAge("2026-11-28T11:59:40Z", now)).toBe("now");
    expect(shortAge("2026-11-28T11:55:00Z", now)).toBe("5m");
    expect(shortAge("2026-11-28T09:00:00Z", now)).toBe("3h");
    expect(shortAge("2026-11-26T12:00:00Z", now)).toBe("2d");
    expect(shortAge(undefined, now)).toBe("");
  });
});
