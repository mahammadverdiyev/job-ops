import { normalizeCountryKey } from "job-ops-shared/location-support";
import { resolveSearchCities } from "job-ops-shared/search-cities";
import type { CreateJobInput } from "job-ops-shared/types/jobs";

/**
 * Jobsearch.az is a Nuxt 2 SPA. Its public JSON API is served from the site
 * origin under a `api-{lang}` prefix (`api-az`, `api-en`, `api-ru`) — notably
 * **not** `/api/`. A plain `Accept: application/json` still returns the SSR
 * HTML shell; only `X-Requested-With: XMLHttpRequest` unlocks JSON.
 */
const JOBSEARCH_BASE_URL = "https://jobsearch.az";
const JOBSEARCH_LANG = "az";
const JOBSEARCH_PUBLIC_SITE = "https://jobsearch.az";
const JOBSEARCH_API_PREFIX = `api-${JOBSEARCH_LANG}`;

/**
 * The list endpoint returns 30 rows on the first page and 25 after that. Each
 * page costs ~3s, so mirroring the whole board is far too slow. The API
 * accepts a server-side `q=` search and reports pagination via `next`; this
 * cap only bounds a term that keeps claiming more pages.
 */
const JOBSEARCH_PAGE_SIZE_HINT = 30;
const JOBSEARCH_MAX_PAGES_PER_TERM = 5;

/** Bakı, the only market with meaningful volume (837 of ~1000 postings). */

export type JobsearchProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    };

export interface RunJobsearchOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  locations?: string[];
  maxJobsPerTerm?: number;
  fetchImpl?: typeof fetch;
  shouldCancel?: () => boolean;
  onProgress?: (event: JobsearchProgressEvent) => void;
}

export interface JobsearchResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

interface JobsearchCompany {
  id?: number;
  title?: string;
  slug?: string;
  logo?: string;
  logo_mini?: string;
}

/**
 * Shape of one row from `/vacancies-az`. Note there is **no location field** —
 * location exists only as a server-side numeric filter. The pipeline therefore
 * receives country evidence derived from the board's single-market nature.
 */
export interface JobsearchRow {
  id?: number;
  title?: string;
  slug?: string;
  created_at?: string;
  salary?: string;
  company?: JobsearchCompany;
  is_vip?: boolean;
  view_count?: number;
}

interface JobsearchListPayload {
  items?: JobsearchRow[];
  next?: string | null;
}

/** Detail payload — only fetched for the fields the list omits. */
interface JobsearchDetailPayload {
  text?: string;
  deadline_at?: string;
  apply_link?: string;
  category?: { title?: string };
  salary?: number;
}

/**
 * Azerbaijani/Turkish dotless `ı` and `İ` are distinct letters that NFD
 * decomposition does not fold, so `Bakı` would never match an English `Baku`
 * selection. Map them before stripping combining marks.
 */
const TURKIC_LETTER_FOLDS: Record<string, string> = {
  "\u0131": "i", // ı
  "\u0130": "i", // İ
  "\u015f": "s", // ş
  "\u011f": "g", // ğ
  "\u00e7": "c", // ç
  "\u00f6": "o", // ö
  "\u00fc": "u", // ü
  "\u0259": "e", // ə
};

function foldTurkicLetters(value: string): string {
  let out = "";
  for (const char of value) {
    out += TURKIC_LETTER_FOLDS[char] ?? char;
  }
  return out;
}

function normalizeText(value: string | null | undefined): string {
  return foldTurkicLetters((value ?? "").toLowerCase())
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Jobsearch renders city names in Azerbaijani orthography (`Bakı`), while the
 * UI offers the English transliteration (`Baku`). These are not diacritic
 * variants — the final letter differs (`ı` vs `u`) — so accent folding cannot
 * reconcile them; an explicit alias table is required.
 */



/**
 * English transliterations for cities whose Azerbaijani spelling is not
 * accent-equivalent to the name the UI offers (`Bakı` vs `Baku`). Cities that
 * already fold cleanly need no entry.
 */
const EXTRA_CITY_ALIASES: Record<string, readonly string[]> = {
  baku: ["baku", "baki"],
  ganja: ["ganja", "gence"],
  sumqayit: ["sumqayit", "sumgait"],
  mingachevir: ["mingachevir", "mingechevir"],
  lankaran: ["lankaran", "lenkeran"],
  shaki: ["shaki", "seki"],
  nakhchivan: ["nakhchivan", "naxcivan"],
  shirvan: ["shirvan", "sirvan"],
  khirdalan: ["khirdalan", "xirdalan"],
  shamakhi: ["shamakhi", "samaxi"],
  gabala: ["gabala", "qebele"],
  quba: ["quba"],
  qusar: ["qusar"],
};

function buildApiUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`/${JOBSEARCH_API_PREFIX}${path}`, JOBSEARCH_BASE_URL);
  url.searchParams.set("hl", JOBSEARCH_LANG);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchJson<T>(args: {
  fetchImpl: typeof fetch;
  url: string;
}): Promise<T> {
  const response = await args.fetchImpl(args.url, {
    headers: {
      accept: "application/json",
      // Without this header the API answers with the Nuxt SSR HTML shell.
      "x-requested-with": "XMLHttpRequest",
      referer: `${JOBSEARCH_PUBLIC_SITE}/vacancies`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Jobsearch API returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Jobsearch API returned an unexpected payload.");
  }

  return payload as T;
}

async function fetchJobsearchPage(args: {
  fetchImpl: typeof fetch;
  page: number;
  searchTerm: string;
}): Promise<{ rows: JobsearchRow[]; hasNext: boolean }> {
  const url = buildApiUrl("/vacancies-az", {
    q: args.searchTerm,
    page: String(args.page),
  });

  const payload = await fetchJson<JobsearchListPayload>({
    fetchImpl: args.fetchImpl,
    url,
  });

  const rows = Array.isArray(payload.items) ? payload.items : [];
  return { rows, hasNext: Boolean(payload.next) };
}

/**
 * Walk the pages the server returned for one search term. The board is
 * searched server-side via `q=`, and a single page costs ~3s, so mirroring the
 * whole board is not viable. The API reports pagination through `next`; the
 * walk stops as soon as it is absent.
 */
async function fetchJobsearchTermRows(args: {
  fetchImpl: typeof fetch;
  searchTerm: string;
  shouldCancel?: () => boolean;
}): Promise<JobsearchRow[]> {
  const rows: JobsearchRow[] = [];

  for (let page = 1; page <= JOBSEARCH_MAX_PAGES_PER_TERM; page += 1) {
    if (args.shouldCancel?.()) break;

    const { rows: pageRows, hasNext } = await fetchJobsearchPage({
      fetchImpl: args.fetchImpl,
      page,
      searchTerm: args.searchTerm,
    });
    rows.push(...pageRows);

    if (!hasNext) break;
    if (pageRows.length < JOBSEARCH_PAGE_SIZE_HINT) break;
  }

  return rows;
}

function buildJobUrl(row: JobsearchRow): string | null {
  const slug = typeof row.slug === "string" ? row.slug.trim() : "";
  if (!slug) return null;
  return `${JOBSEARCH_PUBLIC_SITE}/vacancies/${slug}`;
}

function matchesSearchTerm(row: JobsearchRow, searchTerm: string): boolean {
  const normalizedTerm = normalizeText(searchTerm);
  if (!normalizedTerm) return true;

  const haystack = normalizeText(
    [
      typeof row.title === "string" ? row.title : "",
      row.company && typeof row.company.title === "string"
        ? row.company.title
        : "",
    ].join(" "),
  );

  if (!haystack) return false;
  if (haystack.includes(normalizedTerm)) return true;

  return normalizedTerm
    .split(" ")
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function matchesSelectedCountry(selectedCountry: string | undefined): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  // Jobsearch.az only serves Azerbaijan; `worldwide` therefore includes it.
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;
  return normalizedCountry === "azerbaijan";
}

/**
 * Jobsearch is a single-country board whose list rows carry no location field
 * at all. Country evidence must be supplied explicitly, otherwise the shared
 * location matcher sees an empty candidate list and drops every row.
 */
function buildLocationEvidence(
  country: string,
  city: string | null,
): CreateJobInput["locationEvidence"] {
  return {
    rawLocation: null,
    location: city,
    countryKey: country,
    country,
    city,
    evidenceQuality: "approximate",
    source: "jobsearch",
  };
}

function mapJobsearchRow(
  row: JobsearchRow,
  detail: JobsearchDetailPayload | null,
  evidenceCity: string | null = null,
): CreateJobInput | null {
  const jobUrl = buildJobUrl(row);
  if (!jobUrl) return null;

  const employer =
    row.company && typeof row.company.title === "string"
      ? row.company.title
      : "Unknown Employer";
  const companySlug =
    row.company && typeof row.company.slug === "string"
      ? row.company.slug.trim()
      : undefined;
  const companyLogo =
    row.company &&
    typeof (row.company.logo_mini || row.company.logo) === "string"
      ? row.company.logo_mini || row.company.logo
      : undefined;

  const description =
    detail && typeof detail.text === "string" && detail.text.trim()
      ? detail.text
      : undefined;

  return {
    source: "jobsearch",
    sourceJobId:
      typeof row.id === "number" ? String(row.id) : jobUrl,
    title: typeof row.title === "string" ? row.title : "Unknown Title",
    employer,
    employerUrl: companySlug
      ? `${JOBSEARCH_PUBLIC_SITE}/companies/${companySlug}`
      : undefined,
    jobUrl,
    applicationLink:
      detail && typeof detail.apply_link === "string" && detail.apply_link
        ? detail.apply_link
        : jobUrl,
    /**
     * Jobsearch reports city only through the request, never on the row, so
     * the safest claim is the country. The shared matcher accepts this via
     * `locationEvidence`.
     */
    location: "Azərbaycan",
    locationEvidence: buildLocationEvidence("azerbaijan", evidenceCity),
    jobDescription: description,
    datePosted:
      typeof row.created_at === "string" ? row.created_at : undefined,
    jobFunction:
      detail && detail.category && typeof detail.category.title === "string"
        ? detail.category.title
        : undefined,
    companyLogo,
    isRemote: false,
  };
}

async function fetchJobsearchDetail(args: {
  fetchImpl: typeof fetch;
  slug: string;
}): Promise<JobsearchDetailPayload | null> {
  try {
    return await fetchJson<JobsearchDetailPayload>({
      fetchImpl: args.fetchImpl,
      url: buildApiUrl(`/vacancies-az/${encodeURIComponent(args.slug)}`, {}),
    });
  } catch {
    // A detail failure must not discard an otherwise usable listing.
    return null;
  }
}

export async function runJobsearch(
  options: RunJobsearchOptions = {},
): Promise<JobsearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const searchTerms =
    options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms
      : ["software engineer"];
  const maxJobsPerTerm = toPositiveIntOrFallback(options.maxJobsPerTerm, 50);
  /**
   * `location=<id>` is deliberately NOT sent. The board populates that field
   * sparsely — filtering by Baku drops 16 of 30 "engineer" results, including
   * obviously Baku-based employers (Pasha Real Estate, Holcim, Expro) — so the
   * server-side city filter loses far more than it gains. The board is
   * Azerbaijan-only, and the country gate already restricts the run, so a
   * country-wide search with per-row country evidence is the accurate choice.
   */
  /**
   * The list payload carries no city, so the only city evidence available is
   * what the user asked for. Without it the orchestrator's proximity branch
   * has no candidate to match against and drops every row as `no_match`.
   */
  const requestedLocations = resolveSearchCities({ list: options.locations });

  try {
    const jobs: CreateJobInput[] = [];
    const seen = new Set<string>();

    for (const [index, searchTerm] of searchTerms.entries()) {
      if (options.shouldCancel?.()) {
        return { success: true, jobs };
      }

      options.onProgress?.({
        type: "term_start",
        termIndex: index + 1,
        termTotal: searchTerms.length,
        searchTerm,
      });

      // The board is searched server-side, so only the rows for this term are
      // fetched — mirroring the entire board would take minutes.
      const sourceRows = await fetchJobsearchTermRows({
        fetchImpl,
        searchTerm,
        shouldCancel: options.shouldCancel,
      });

      let jobsFoundTerm = 0;
      for (const row of sourceRows) {
        if (options.shouldCancel?.()) {
          return { success: true, jobs };
        }
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        if (!matchesSearchTerm(row, searchTerm)) continue;
        if (!matchesSelectedCountry(options.selectedCountry)) continue;

        const slug = typeof row.slug === "string" ? row.slug.trim() : "";
        const detail = slug
          ? await fetchJobsearchDetail({ fetchImpl, slug })
          : null;

        const mapped = mapJobsearchRow(
          row,
          detail,
          requestedLocations[0] ?? null,
        );
        if (!mapped) continue;

        const dedupeKey = mapped.sourceJobId || mapped.jobUrl;
        if (seen.has(dedupeKey)) continue;

        seen.add(dedupeKey);
        jobs.push(mapped);
        jobsFoundTerm += 1;
      }

      options.onProgress?.({
        type: "term_complete",
        termIndex: index + 1,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm,
      });
    }

    return { success: true, jobs };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unexpected error while running Jobsearch extractor.";

    return { success: false, jobs: [], error: message };
  }
}

function toPositiveIntOrFallback(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}
