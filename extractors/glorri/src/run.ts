import { normalizeCountryKey } from "job-ops-shared/location-support";
import {
  matchesRequestedCity,
  normalizeLocationToken,
  resolveSearchCities,
} from "job-ops-shared/search-cities";
import type { CreateJobInput } from "job-ops-shared/types/jobs";

const GLORRI_API_URL = "https://api.glorri.com/job-service-v2/jobs/public";
const GLORRI_PUBLIC_SITE = "https://jobs.glorri.az";

/**
 * The public endpoint rejects any page size above 20 with a 200 response whose
 * body is `{ ok: false }` instead of a job list, so this must stay <= 20.
 */
const GLORRI_PAGE_SIZE = 20;
/** Hard ceiling on pages pulled per run: 50 * 20 = 1000 jobs, above the board size. */
const GLORRI_MAX_PAGES = 50;

export type GlorriWorkplaceType = "remote" | "hybrid" | "onsite";

export type GlorriProgressEvent =
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

export interface RunGlorriOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  locations?: string[];
  workplaceTypes?: GlorriWorkplaceType[];
  maxJobsPerTerm?: number;
  fetchImpl?: typeof fetch;
  shouldCancel?: () => boolean;
  onProgress?: (event: GlorriProgressEvent) => void;
}

export interface GlorriResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

interface GlorriCompany {
  slug?: string;
  name?: string;
  logo?: string;
}

export interface GlorriRow {
  id?: string;
  title?: string;
  slug?: string;
  location?: string;
  type?: string;
  jobFunction?: string;
  careerLevel?: string;
  postedDate?: string;
  isRemote?: boolean;
  company?: GlorriCompany;
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

async function fetchGlorriPage(args: {
  fetchImpl: typeof fetch;
  offset: number;
}): Promise<{ rows: GlorriRow[]; total: number }> {
  const url = new URL(GLORRI_API_URL);
  url.searchParams.set("offset", String(args.offset));
  url.searchParams.set("limit", String(GLORRI_PAGE_SIZE));

  const response = await args.fetchImpl(url.toString(), {
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: GLORRI_PUBLIC_SITE,
      referer: `${GLORRI_PUBLIC_SITE}/`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Glorri API returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Glorri API returned an unexpected payload.");
  }

  const entities = (payload as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) {
    // The API answers `{ ok: false, message }` for rejected parameters.
    throw new Error("Glorri API payload has no job entities.");
  }

  const rawTotal = (payload as { totalCount?: unknown }).totalCount;
  const total =
    typeof rawTotal === "number" && Number.isFinite(rawTotal)
      ? rawTotal
      : entities.length;

  return { rows: entities as GlorriRow[], total };
}

async function fetchAllGlorriJobs(args: {
  fetchImpl: typeof fetch;
  shouldCancel?: () => boolean;
}): Promise<GlorriRow[]> {
  const rows: GlorriRow[] = [];

  for (let page = 0; page < GLORRI_MAX_PAGES; page += 1) {
    if (args.shouldCancel?.()) break;

    const offset = page * GLORRI_PAGE_SIZE;
    const result = await fetchGlorriPage({ fetchImpl: args.fetchImpl, offset });
    rows.push(...result.rows);

    if (result.rows.length < GLORRI_PAGE_SIZE) break;
    if (offset + GLORRI_PAGE_SIZE >= result.total) break;
  }

  return rows;
}

function buildJobUrl(row: GlorriRow): string | null {
  const slug = typeof row.slug === "string" ? row.slug.trim() : "";
  const companySlug =
    row.company && typeof row.company.slug === "string"
      ? row.company.slug.trim()
      : "";
  if (!slug || !companySlug) return null;
  return `${GLORRI_PUBLIC_SITE}/vacancies/${companySlug}/${slug}`;
}

function matchesSearchTerm(row: GlorriRow, searchTerm: string): boolean {
  const normalizedTerm = normalizeText(searchTerm);
  if (!normalizedTerm) return true;

  const haystack = normalizeText(
    [
      typeof row.title === "string" ? row.title : "",
      row.company && typeof row.company.name === "string"
        ? row.company.name
        : "",
      typeof row.location === "string" ? row.location : "",
      typeof row.jobFunction === "string" ? row.jobFunction : "",
      typeof row.careerLevel === "string" ? row.careerLevel : "",
    ].join(" "),
  );

  if (!haystack) return false;
  if (haystack.includes(normalizedTerm)) return true;

  return normalizedTerm
    .split(" ")
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/**
 * Glorri reports Azerbaijani city names using Azerbaijani orthography
 * (`Bakı`), but the UI offers the English transliteration (`Baku`). These are
 * not diacritic variants — the final letter differs (`ı` vs `u`) — so
 * accent-folding can never reconcile them. An explicit alias table is the only
 * reliable bridge.
 */
const CITY_LOCATION_ALIASES: Record<string, readonly string[]> = {
  baku: ["baku", "bakı", "baki"],
  ganja: ["ganja", "gəncə", "gence"],
  sumqayit: ["sumqayit", "sumqayıt", "sumgait"],
  mingachevir: ["mingachevir", "mingəçevir", "mingechevir"],
  lankaran: ["lankaran", "lənkəran", "lenkeran"],
  shaki: ["shaki", "şəki", "seki"],
  nakhchivan: ["nakhchivan", "naxçıvan", "naxcivan"],
  shirvan: ["shirvan", "şirvan", "sirvan"],
  quba: ["quba", "quba"],
  khirdalan: ["khirdalan", "xırdalan", "xirdalan"],
};

function matchesRequestedLocation(
  location: string | undefined,
  requestedLocation: string,
): boolean {
  if (!location) return false;
  if (matchesRequestedCity(location, requestedLocation)) return true;

  const foldedLocation = normalizeText(location);
  const foldedRequested = normalizeText(requestedLocation);
  if (!foldedLocation || !foldedRequested) return false;

  // Exact/inclusive match on the folded forms.
  if (foldedLocation.includes(foldedRequested)) return true;

  // Transliteration aliases: expand whichever side is a known city.
  const requestedAliases =
    CITY_LOCATION_ALIASES[foldedRequested] ?? undefined;
  if (requestedAliases) {
    return requestedAliases.some((alias) =>
      foldedLocation.includes(normalizeText(alias)),
    );
  }

  // The board may name the city while the user typed the country, or vice
  // versa; check every alias group for a token overlap.
  for (const aliases of Object.values(CITY_LOCATION_ALIASES)) {
    const locationHit = aliases.some((alias) =>
      foldedLocation.includes(normalizeText(alias)),
    );
    if (!locationHit) continue;
    if (aliases.some((alias) => normalizeText(alias) === foldedRequested)) {
      return true;
    }
  }

  return false;
}

/**
 * Glorri renders locations in the posting's own language (e.g. `Bakı,
 * Azərbaycan`), and `normalizeCountryKey` only slugifies — it does not
 * translate — so an English country selection never matches the raw string.
 * These aliases bridge the two spellings for the markets the board serves.
 */
const COUNTRY_LOCATION_ALIASES: Record<string, readonly string[]> = {
  azerbaijan: ["azerbaijan", "azərbaycan", "azerbaycan"],
};

function matchesSelectedCountry(
  row: GlorriRow,
  selectedCountry: string | undefined,
): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;

  const location =
    typeof row.location === "string" ? normalizeText(row.location) : "";
  if (!location) return false;

  const aliases = COUNTRY_LOCATION_ALIASES[normalizedCountry] ?? [
    normalizedCountry,
  ];
  return aliases.some((alias) => location.includes(normalizeText(alias)));
}

function matchesWorkplaceTypes(
  row: GlorriRow,
  workplaceTypes: GlorriWorkplaceType[] | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.some((type) =>
    type === "remote" ? row.isRemote === true : row.isRemote !== true,
  );
}

/**
 * Resolve the English country key for a Glorri row so downstream shared
 * matchers see a canonical country even when the board renders it in
 * Azerbaijani (`Bakı, Azərbaycan`).
 */
function resolveCanonicalCountry(row: GlorriRow): string | undefined {
  const location =
    typeof row.location === "string" ? normalizeText(row.location) : "";
  if (!location) return undefined;

  for (const [countryKey, aliases] of Object.entries(
    COUNTRY_LOCATION_ALIASES,
  )) {
    if (aliases.some((alias) => location.includes(normalizeText(alias)))) {
      return countryKey;
    }
  }
  return undefined;
}

function mapGlorriRow(row: GlorriRow): CreateJobInput | null {
  const jobUrl = buildJobUrl(row);
  if (!jobUrl) return null;

  const employer =
    row.company && typeof row.company.name === "string"
      ? row.company.name
      : "Unknown Employer";
  const companySlug =
    row.company && typeof row.company.slug === "string"
      ? row.company.slug.trim()
      : undefined;

  return {
    source: "glorri",
    sourceJobId: typeof row.id === "string" ? row.id : jobUrl,
    title: typeof row.title === "string" ? row.title : "Unknown Title",
    employer,
    employerUrl: companySlug
      ? `${GLORRI_PUBLIC_SITE}/companies/${companySlug}`
      : undefined,
    jobUrl,
    applicationLink: jobUrl,
    location: typeof row.location === "string" ? row.location : undefined,
    /**
     * The raw `location` is in the posting's own language, which the shared
     * country matcher cannot read. Emitting evidence with the canonical
     * English country keeps the orchestrator's location filter from dropping
     * every Glorri row as `no_match`.
     */
    locationEvidence: (() => {
      const country = resolveCanonicalCountry(row);
      const rawLocation =
        typeof row.location === "string" ? row.location : undefined;
      if (!country && !rawLocation) return undefined;
      return {
        rawLocation: rawLocation ?? null,
        location: rawLocation ?? null,
        countryKey: country ?? null,
        country: country ?? null,
        city: null,
        evidenceQuality: country ? "approximate" : "weak",
        source: "glorri",
      };
    })(),
    datePosted:
      typeof row.postedDate === "string" ? row.postedDate : undefined,
    jobType: typeof row.type === "string" ? row.type : undefined,
    jobFunction:
      typeof row.jobFunction === "string" ? row.jobFunction : undefined,
    jobLevel:
      typeof row.careerLevel === "string" && row.careerLevel.trim()
        ? row.careerLevel
        : undefined,
    companyLogo:
      row.company && typeof row.company.logo === "string"
        ? row.company.logo
        : undefined,
    isRemote: row.isRemote === true,
  };
}

function resolveExplicitLocations(
  locations: string[] | undefined,
  selectedCountry: string | undefined,
): string[] {
  const normalizedCountry = normalizeCountryKey(selectedCountry);

  return resolveSearchCities({ list: locations }).filter((location) => {
    const normalizedLocation = normalizeLocationToken(location);
    if (!normalizedLocation) return false;
    if (!normalizedCountry) return true;
    return normalizedLocation !== normalizedCountry;
  });
}

export async function runGlorri(
  options: RunGlorriOptions = {},
): Promise<GlorriResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const searchTerms =
    options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms
      : ["software engineer"];
  const maxJobsPerTerm = toPositiveIntOrFallback(options.maxJobsPerTerm, 50);
  const explicitLocations = resolveExplicitLocations(
    options.locations,
    options.selectedCountry,
  );

  try {
    const sourceRows = await fetchAllGlorriJobs({
      fetchImpl,
      shouldCancel: options.shouldCancel,
    });
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

      let jobsFoundTerm = 0;
      for (const row of sourceRows) {
        if (options.shouldCancel?.()) {
          return { success: true, jobs };
        }
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        if (!matchesSearchTerm(row, searchTerm)) continue;
        if (!matchesSelectedCountry(row, options.selectedCountry)) continue;
        if (!matchesWorkplaceTypes(row, options.workplaceTypes)) continue;

        const mapped = mapGlorriRow(row);
        if (!mapped) continue;
        if (
          explicitLocations.length > 0 &&
          !explicitLocations.some((location) =>
            matchesRequestedLocation(mapped.location, location),
          )
        ) {
          continue;
        }

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
          : "Unexpected error while running Glorri extractor.";

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