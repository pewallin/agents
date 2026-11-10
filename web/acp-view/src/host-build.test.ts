import { describe, expect, it } from "vitest";
import { hostOutdated, outdatedHostAction, viewBuild, VIEW_BUILD_META } from "./host-build";

describe("host build", () => {
  it("reads the build a release's view came with, and none from a view built apart", () => {
    const doc = (content: string | null) => ({
      querySelector: (selector: string) => selector === `meta[name="${VIEW_BUILD_META}"]` && content !== null
        ? { getAttribute: (name: string) => (name === "content" ? content : null) }
        : null,
    }) as unknown as Document;
    expect(viewBuild(doc("1.0.0+4f90f234d36f"))).toBe("1.0.0+4f90f234d36f");
    expect(viewBuild(doc(" "))).toBeUndefined();
    expect(viewBuild(doc(null))).toBeUndefined();
  });

  it("finds a host outdated only when both builds are known and differ", () => {
    expect(hostOutdated("1.0.0+4f90f234d36f", "1.0.0+22f32804e84b")).toBe(true);
    expect(hostOutdated("1.0.0+4f90f234d36f", "1.0.0+4f90f234d36f")).toBe(false);
    expect(hostOutdated(undefined, "1.0.0+22f32804e84b")).toBe(false);
    expect(hostOutdated("1.0.0+4f90f234d36f", undefined)).toBe(false);
    expect(hostOutdated("1.0.0+4f90f234d36f", "dev")).toBe(false);
  });

  it("restarts a Codex host by itself only while nothing is going on, and offers the rest", () => {
    expect(outdatedHostAction({ mode: "live", inApp: true, idle: true, tried: false })).toBe("restart-host");
    expect(outdatedHostAction({ mode: "live", inApp: true, idle: false, tried: false })).toBe("offer-host-restart");
    expect(outdatedHostAction({ mode: "live", inApp: true, idle: true, tried: true })).toBe("offer-host-restart");
    expect(outdatedHostAction({ mode: "handoff", inApp: true, idle: true, tried: false })).toBe("offer-agent-restart");
    expect(outdatedHostAction({ mode: "handoff", inApp: false, idle: true, tried: false })).toBe("say");
  });
});
