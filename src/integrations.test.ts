import { describe, expect, it } from "vitest";
import {
  integrationSpec,
  missingLifecycleCapabilities,
  missingMetadataCapabilities,
} from "./integrations.js";

describe("integration specs", () => {
  it("reports codex gaps explicitly", () => {
    const spec = integrationSpec("codex");
    expect(missingLifecycleCapabilities(spec)).toEqual([]);
    expect(missingMetadataCapabilities(spec)).toEqual([]);
  });

  it("reports claude metadata as fully covered", () => {
    const spec = integrationSpec("claude");
    expect(missingLifecycleCapabilities(spec)).toEqual([]);
    expect(missingMetadataCapabilities(spec)).toEqual([]);
  });

  it("shows copilot metadata as fully covered", () => {
    const spec = integrationSpec("copilot");
    expect(missingLifecycleCapabilities(spec)).toEqual([]);
    expect(missingMetadataCapabilities(spec)).toEqual([]);
  });

  it("captures pi approval as an auxiliary capability", () => {
    const spec = integrationSpec("pi");
    expect(missingLifecycleCapabilities(spec)).toEqual(["approval"]);
    expect(spec.optionalCapabilities?.approval).toBe(true);
  });
});
