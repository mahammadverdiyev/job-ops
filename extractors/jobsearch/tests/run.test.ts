import { describe, expect, it } from "vitest";
import { runJobsearch } from "../src/run";

function createResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

const ENGINEER_ROW = {
  id: 155130,
  title: "Mechanical Engineer",
  slug: "pasha-mechanical-engineer-155130",
  created_at: "2026-10-30T00:00:00+04:00",
  salary: "",
  company: { id: 1, title: "Pasha Real Estate", slug: "pasha" },
};

const TEACHER_ROW = {
  id: 155143,
  title: "General English grammatika müəllimi",
  slug: "star-colleges-english-155143",
  created_at: "2026-10-30T00:00:00+04:00",
  company: { id: 2, title: "Star Colleges", slug: "star-colleges" },
};

/**
 * Minimal fake of the two Jobsearch endpoints: the list endpoint returns the
 * given rows for page 1 and nothing after, and the detail endpoint answers
 * with a fixed description.
 */
function makeFetch(rows: unknown[], detail: unknown = { text: "desc" }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/vacancies-az/")) return createResponse(detail);
    if (url.includes("page=1")) return createResponse({ items: rows });
    return createResponse({ items: [] });
  }) as typeof fetch;
  return { impl, calls };
}

describe("runJobsearch", () => {
  it("maps list rows to job inputs with a jobsearch source", async () => {
    const { impl } = makeFetch([ENGINEER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job.source).toBe("jobsearch");
    expect(job.title).toBe("Mechanical Engineer");
    expect(job.employer).toBe("Pasha Real Estate");
    expect(job.jobUrl).toBe(
      "https://jobsearch.az/vacancies/pasha-mechanical-engineer-155130",
    );
    expect(job.sourceJobId).toBe("155130");
  });

  it("filters out rows that do not match the search term", async () => {
    const { impl } = makeFetch([ENGINEER_ROW, TEACHER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe("Mechanical Engineer");
  });

  it("attaches English country evidence so the shared matcher accepts it", async () => {
    const { impl } = makeFetch([ENGINEER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    const evidence = result.jobs[0].locationEvidence;
    expect(evidence?.country).toBe("azerbaijan");
    expect(evidence?.countryKey).toBe("azerbaijan");
    expect(evidence?.source).toBe("jobsearch");
  });

  it("returns no jobs when a different country is selected", async () => {
    const { impl } = makeFetch([ENGINEER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "germany",
      fetchImpl: impl,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(0);
  });

  it("does not send a city filter, because the board populates it sparsely", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      return page([BAKU_DATA_ENGINEER]);
    }) as unknown as typeof fetch;

    await runJobsearch({
      searchTerms: ["data engineer"],
      selectedCountry: "azerbaijan",
      locations: ["Baku"],
      fetchImpl,
    });

    expect(calls.length).toBeGreaterThan(0);
    // Filtering by location=<id> drops Baku employers whose rows omit the
    // field, so the extractor must search the whole country instead.
    expect(calls.some((url) => url.includes("location="))).toBe(false);
  });

  it("does not drop rows for an unknown requested city", async () => {
    const { impl } = makeFetch([ENGINEER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      locations: ["Somewhere Unknown"],
      fetchImpl: impl,
    });

    expect(result.jobs).toHaveLength(1);
  });

  it("sends the X-Requested-With header required for JSON", async () => {
    let seenHeaders: Record<string, string> = {};
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return createResponse({ items: [] });
    }) as typeof fetch;

    await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    expect(
      seenHeaders["x-requested-with"] ?? seenHeaders["X-Requested-With"],
    ).toBe("XMLHttpRequest");
  });

  it("reports a failure when the API returns a non-ok status", async () => {
    const impl = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as Response) as typeof fetch;

    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(0);
    expect(result.error).toContain("500");
  });

  it("respects maxJobsPerTerm", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...ENGINEER_ROW,
      id: 1000 + i,
      slug: `acme-engineer-${1000 + i}`,
    }));
    const { impl } = makeFetch(rows);
    const result = await runJobsearch({
      searchTerms: ["engineer"],
      selectedCountry: "azerbaijan",
      maxJobsPerTerm: 2,
      fetchImpl: impl,
    });

    expect(result.jobs).toHaveLength(2);
  });

  it("dedupes rows seen across multiple search terms", async () => {
    const { impl } = makeFetch([ENGINEER_ROW]);
    const result = await runJobsearch({
      searchTerms: ["engineer", "mechanical"],
      selectedCountry: "azerbaijan",
      fetchImpl: impl,
    });

    expect(result.jobs).toHaveLength(1);
  });
});
