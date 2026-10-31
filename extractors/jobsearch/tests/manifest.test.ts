import { describe, expect, it } from "vitest";
import { manifest } from "../src/manifest";

describe("jobsearch manifest", () => {
  it("declares the jobsearch source id", () => {
    expect(manifest.id).toBe("jobsearch");
    expect(manifest.providesSources).toContain("jobsearch");
  });

  it("is gated to Azerbaijan only", () => {
    expect(
      manifest.locationCapabilities?.jobsearch?.supportedCountryKeys,
    ).toEqual(["azerbaijan"]);
  });

  it("opts into location evidence", () => {
    expect(manifest.capabilities?.locationEvidence).toBe(true);
  });
});
