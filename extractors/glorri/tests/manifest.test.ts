import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runGlorri: vi.fn(),
}));

describe("glorri manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards automatic-run settings to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runGlorri } = await import("../src/run");
    const runGlorriMock = vi.mocked(runGlorri);
    runGlorriMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "glorri",
      selectedSources: ["glorri"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote","hybrid"]',
        searchCities: "Bakı",
      },
      searchTerms: ["data engineer"],
      selectedCountry: "azerbaijan",
    });

    expect(runGlorriMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote", "hybrid"],
        locations: ["Bakı"],
        selectedCountry: "azerbaijan",
      }),
    );
  });

  it("declares azerbaijan as its only supported country", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.providesSources).toEqual(["glorri"]);
    expect(manifest.locationCapabilities?.glorri?.supportedCountryKeys).toEqual(
      ["azerbaijan"],
    );
  });

  it("reports failures from the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runGlorri } = await import("../src/run");
    vi.mocked(runGlorri).mockResolvedValue({
      success: false,
      jobs: [],
      error: "boom",
    });

    const result = await manifest.run({
      source: "glorri",
      selectedSources: ["glorri"],
      settings: {},
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
    });

    expect(result).toEqual({ success: false, jobs: [], error: "boom" });
  });
});