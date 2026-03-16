import { describe, it, expect } from "vitest";
import { getDetector } from "./scanner.js";

describe("getDetector", () => {
  it("returns hook detector for claude", () => {
    const d = getDetector("claude");
    expect(d).toBeDefined();
  });

  it("returns hook detector for copilot", () => {
    const d = getDetector("copilot");
    expect(d).toBeDefined();
  });

  it("returns generic detector for unknown agents", () => {
    const d = getDetector("codex");
    expect(d).toBeDefined();
  });

  it("is case-insensitive", () => {
    const a = getDetector("Claude");
    const b = getDetector("claude");
    expect(a).toBe(b);
  });
});

describe("generic detector (screen-scraping)", () => {
  // Get the generic detector via an unknown agent name
  const detector = getDetector("codex");

  describe("isApproval", () => {
    it("matches (Y/n) prompt", () => {
      expect(detector.isApproval("Do you want to proceed? (Y/n)")).toBe(true);
    });

    it("matches (y/N) prompt", () => {
      expect(detector.isApproval("Continue? (y/N)")).toBe(true);
    });

    it("matches copilot selection UI", () => {
      expect(detector.isApproval("↑↓ to select · Enter to confirm")).toBe(true);
    });

    it("matches copilot navigation UI", () => {
      expect(detector.isApproval("↑↓ to navigate · Enter to select")).toBe(true);
    });

    it("matches Allow this action", () => {
      expect(detector.isApproval("Allow this action")).toBe(true);
    });

    it("matches claude permission prompt", () => {
      expect(detector.isApproval("△ Permission required")).toBe(true);
    });

    it("matches claude Allow once/always/Reject", () => {
      expect(detector.isApproval("Allow once  Allow always  Reject")).toBe(true);
    });

    it("does not match normal content", () => {
      expect(detector.isApproval("Hello world\nThis is some code")).toBe(false);
    });
  });

  describe("isWorking", () => {
    it("matches braille spinner in content", () => {
      expect(detector.isWorking("⠋ Loading...", "")).toBe(true);
    });

    it("matches spinner in title", () => {
      expect(detector.isWorking("", "⠋ Working")).toBe(true);
    });

    it("matches Working... keyword", () => {
      expect(detector.isWorking("Working...", "")).toBe(true);
    });

    it("matches Thinking... keyword", () => {
      expect(detector.isWorking("Thinking...", "")).toBe(true);
    });

    it("does not match idle content", () => {
      expect(detector.isWorking("❯ ", "terminal")).toBe(false);
    });
  });

  describe("isIdle", () => {
    it("matches shell prompt ❯", () => {
      expect(detector.isIdle("some output\n❯ ", "")).toBe(true);
    });

    it("matches shell prompt ›", () => {
      expect(detector.isIdle("some output\n› ", "")).toBe(true);
    });

    it("matches $ prompt", () => {
      expect(detector.isIdle("some output\n$ ", "")).toBe(true);
    });

    it("matches copilot tab agents prompt", () => {
      expect(detector.isIdle("some output\ntab agents  ctrl+p commands", "")).toBe(true);
    });

    it("does not match working content", () => {
      expect(detector.isIdle("⠋ Loading data from server", "")).toBe(false);
    });
  });
});
