import { describe, expect, it, vi } from "vitest";
import { runGlorri } from "../src/run";

function createResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function page(entities: unknown[], totalCount?: number): Response {
  return createResponse({
    entities,
    totalCount: totalCount ?? entities.length,
  });
}

const BAKU_ENGINEER = {
  id: "job-1",
  title: "Data Engineer",
  slug: "acme-data-engineer-1",
  location: "Bakı, Azərbaycan",
  type: "Tam ştat",
  jobFunction: "İnformasiya Texnologiyaları",
  careerLevel: "Orta",
  postedDate: "2026-10-08T10:00:00.000Z",
  isRemote: false,
  company: { slug: "acme", name: "Acme MMC", logo: "https://cdn/acme.png" },
};

const BAKU_DESIGNER = {
  id: "job-2",
  title: "Product Designer",
  slug: "beta-product-designer-2",
  location: "Bakı, Azərbaycan",
  isRemote: false,
  company: { slug: "beta", name: "Beta MMC" },
};

const REMOTE_ENGINEER = {
  id: "job-3",
  title: "Senior Backend Engineer",
  slug: "gamma-senior-backend-engineer-3",
  location: "Bakı, Azərbaycan",
  isRemote: true,
  company: { slug: "gamma", name: "Gamma" },
};

describe("runGlorri", () => {
  it("filters by search term, maps core fields and builds the posting URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([BAKU_ENGINEER, BAKU_DESIGNER]));

    const result = await runGlorri({
      searchTerms: ["data engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);

    const job = result.jobs[0];
    expect(job.source).toBe("glorri");
    expect(job.sourceJobId).toBe("job-1");
    expect(job.title).toBe("Data Engineer");
    expect(job.employer).toBe("Acme MMC");
    expect(job.jobUrl).toBe(
      "https://jobs.glorri.az/vacancies/acme/acme-data-engineer-1",
    );
    expect(job.applicationLink).toBe(job.jobUrl);
    expect(job.location).toBe("Bakı, Azərbaycan");
    expect(job.datePosted).toBe("2026-10-08T10:00:00.000Z");
    expect(job.jobType).toBe("Tam ştat");
    expect(job.isRemote).toBe(false);
    expect(job.companyLogo).toBe("https://cdn/acme.png");
  });

  it("keeps every term when the term is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([BAKU_ENGINEER, BAKU_DESIGNER]));

    const result = await runGlorri({
      searchTerms: [""],
      fetchImpl: fetchMock,
    });

    expect(result.jobs).toHaveLength(2);
  });

  it("filters by selected country and rejects non-Azerbaijan selections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([BAKU_ENGINEER]))
      .mockResolvedValueOnce(page([BAKU_ENGINEER]));

    const az = await runGlorri({
      searchTerms: ["data engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: fetchMock,
    });
    expect(az.jobs).toHaveLength(1);

    const de = await runGlorri({
      searchTerms: ["data engineer"],
      selectedCountry: "germany",
      fetchImpl: fetchMock,
    });
    expect(de.success).toBe(true);
    expect(de.jobs).toHaveLength(0);
  });

  it("filters by workplace type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        page([BAKU_ENGINEER, REMOTE_ENGINEER], 2),
      );

    const remoteOnly = await runGlorri({
      searchTerms: ["engineer"],
      workplaceTypes: ["remote"],
      fetchImpl: fetchMock,
    });
    expect(remoteOnly.jobs.map((job) => job.sourceJobId)).toEqual(["job-3"]);
  });

  it("pages until the reported total is reached", async () => {
    const first = Array.from({ length: 20 }, (_unused, index) => ({
      ...BAKU_ENGINEER,
      id: `p0-${index}`,
      slug: `acme-engineer-${index}`,
    }));
    const second = [
      { ...BAKU_ENGINEER, id: "p1-0", slug: "acme-engineer-last" },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(first, 21))
      .mockResolvedValueOnce(page(second, 21));

    const result = await runGlorri({
      searchTerms: ["engineer"],
      fetchImpl: fetchMock,
      maxJobsPerTerm: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.jobs).toHaveLength(21);
  });

  it("throws a readable error when the API rejects the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse({ ok: false, message: "bad" }));

    const result = await runGlorri({
      searchTerms: ["engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("entities");
  });

  it("surfaces HTTP failures as an unsuccessful result", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    const result = await runGlorri({
      searchTerms: ["engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });

  it("skips rows that cannot produce a posting URL", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page([
        { id: "no-slug", title: "Engineer", location: "Bakı" },
        { id: "no-company", title: "Engineer", slug: "x-engineer-9" },
      ]),
    );

    const result = await runGlorri({
      searchTerms: ["engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([]);
  });

  it("matches an English city name against the Azerbaijani location", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([BAKU_ENGINEER]));

    const result = await runGlorri({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      locations: ["Baku"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.locationEvidence?.country).toBe("azerbaijan");
  });

  it("stops early when cancellation is requested", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([BAKU_ENGINEER]));

    const result = await runGlorri({
      searchTerms: ["engineer"],
      fetchImpl: fetchMock,
      shouldCancel: () => true,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits English country evidence for Azerbaijani locations", async () => {
    // Regression: the shared orchestrator location filter drops any row whose
    // location it cannot resolve to the selected country. Glorri returns
    // `Bakı, Azərbaycan`, which `normalizeCountryKey` cannot translate, so
    // without evidence every Glorri job was discarded as `no_match`.
    const fetchMock = vi.fn().mockResolvedValueOnce(page([BAKU_ENGINEER]));

    const result = await runGlorri({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.locationEvidence).toMatchObject({
      countryKey: "azerbaijan",
      country: "azerbaijan",
      source: "glorri",
    });
  });
});