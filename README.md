<div align="center">

# Job<span>Ops</span> — Azerbaijan Edition

**One search across every board. One click to tailor your CV. One place to track it all.**

A fork of [JobOps](https://github.com/DaKheera47/job-ops) extended with **first-class support for Azerbaijani job boards** — Glorri and Jobsearch.az — alongside LinkedIn. More local sources are on the roadmap.

<br>

[![Upstream](https://img.shields.io/badge/upstream-DaKheera47%2Fjob--ops-blue?logo=github)](https://github.com/DaKheera47/job-ops)
[![GHCR](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker&logoColor=white)](https://github.com/DaKheera47/job-ops/pkgs/container/job-ops)
[![License](https://img.shields.io/badge/license-AGPLv3%20%2B%20Commons%20Clause-lightgrey)](./LICENSE)

</div>

---

## What is JobOps?

JobOps searches multiple job boards from one screen, rewrites your CV for each role, scores your fit, checks visa sponsorship status, and tracks every application in one place.

It does not auto-apply. Recruiters can tell when applications are automated and it gets you blacklisted. JobOps gives you the speed without sacrificing quality.

---

## Azerbaijan Support

This fork focuses on making JobOps genuinely usable for the Azerbaijani job market, where the global boards have thin coverage.

| Source | Coverage | Notes |
|--------|----------|-------|
| **LinkedIn** | Azerbaijan | Enabled via the JobSpy extractor. Country gating previously blocked `azerbaijan` in the UI; that is fixed here. |
| **Glorri** | Azerbaijan | New extractor. Pages the public [jobs.glorri.az](https://jobs.glorri.az) board and filters by term, country, workplace type, and city. |
| **Jobsearch.az** | Azerbaijan | New extractor. Uses the site's undocumented JSON API (`api-{lang}` prefix) — no HTML scraping. |
| Indeed | — | Returns nothing for Azerbaijan; Indeed has no `.az` site. |

### Why the Azerbaijani sources needed real work

Both boards publish in Azerbaijani, and the shared orchestrator filter expects English country names. That mismatch caused **every row to be silently dropped** as `no_match` — 45 jobs from Glorri and 95 from Jobsearch.az were discovered and then discarded before reaching the database.

Three separate problems had to be solved:

1. **Country evidence.** Locations like `Bakı, Azərbaycan` never matched the requested `azerbaijan`, because the shared matcher's variant list covers English plus de/es/fr/it/nl/pt/tr — but no `az`. Both extractors now supply explicit `locationEvidence` with the canonical English country, the same mechanism the Naukri and Adzuna extractors already use.

2. **City selection.** When a city is chosen, the pipeline switches into its proximity branch, which needs city tokens to compare against. Jobsearch.az's list payload carries **no location field at all**, so there was nothing to match. The extractor now threads the requested city into the evidence.

3. **Transliteration.** `Baku` ≠ `Bakı`. The Azerbaijani letter `ı` (dotless i) folds to `i`, not `u`, so diacritic folding alone cannot bridge it. Glorri uses an explicit alias table instead: Baku/Bakı/Baki, Gəncə/Ganja, Sumqayıt, Mingəçevir, Lənkəran, Şəki, Naxçıvan, Şirvan, Xırdalan.

### Verified behaviour

```
Azerbaijan + "data engineer" + Baku
  Glorri        -> 2 jobs   (Rabitəbank ASC, AFEA Group)
  Jobsearch.az  -> 2 jobs   (Professional İT MMC, FutureUp Academy)
  LinkedIn      -> works, unaffected

Germany (unsupported) -> 0 jobs, correctly gated
```

These figures come from live runs inside the production container, not unit tests.

---

## Quick Start

```bash
git clone https://github.com/mahammadverdiyev/job-ops.git
cd job-ops
docker compose up -d
```

Open `http://localhost:3005` and follow the onboarding wizard.

For a guided walkthrough, see the [upstream self-hosting guide](https://jobops.dakheera47.com/docs/getting-started/self-hosting).

---

## How It Works

| Step | What happens |
|------|-------------|
| **Search** | Scrapes the selected job boards for roles matching your criteria |
| **Score** | AI ranks each job 0-100 against your profile |
| **Tailor** | Generates a rewritten CV matched to each job description |
| **Export** | Creates a polished PDF locally, or via [Reactive Resume](https://rxresu.me) |
| **Track** | Connects to Gmail and auto-detects interviews, offers, and rejections |

---

## Supported Job Boards

| Platform | Focus |
|----------|-------|
| LinkedIn | Global |
| Indeed | Global |
| Glassdoor | Global |
| Adzuna | Multi-country API |
| Hiring Cafe | Global |
| startup.jobs | Startup/remote roles |
| Working Nomads | Remote-only |
| Gradcracker | STEM/Grads (UK) |
| UK Visa Jobs | Sponsorship (UK) |
| Golang Jobs | Go developers |
| Seek | Australia/NZ (via Apify) |
| Naukri | India |
| Jobindex | Denmark |
| WUZZUF | Egypt (Job Board) |
| Khamsat | Egypt (Freelance) |
| FreeHire | Remote/tech |
| **Glorri** | **Azerbaijan** (this fork) |
| **Jobsearch.az** | **Azerbaijan** (this fork) |

Custom extractors can be added via TypeScript. See the [extractor docs](https://jobops.dakheera47.com/docs/extractors/overview).

---

## Adding a New Extractor

Each extractor is a self-contained workspace under `extractors/`, exposing a `manifest.ts` and a `run.ts`. Registering one takes five steps — the Dockerfile copy is the one most easily missed, because it uses an **explicit per-extractor list rather than a glob**:

1. Create `extractors/<name>/` with `package.json`, `tsconfig.json`, `src/manifest.ts`, `src/run.ts`, and `tests/`
2. Register the source id and label in [`shared/src/extractors/index.ts`](./shared/src/extractors/index.ts)
3. Add the extractor to all four Dockerfile copy sites (two `package*.json` lines, two source-directory lines)
4. Register the health probe in `orchestrator/src/server/services/extractor-health.ts`
5. Add the workspace entry to `package-lock.json`, or the Docker build fails to resolve it

Single-country boards should also declare `locationCapabilities` and, when the board's locations are not in English, `capabilities: { locationEvidence: true }`. See `extractors/glorri/` and `extractors/jobsearch/` for working examples.

---

## Post-Application Tracking

Connect your Gmail and JobOps watches for recruiter replies automatically.

- *"We'd like to invite you to interview..."* -> Status updates to **Interviewing**
- *"Unfortunately we won't be progressing..."* -> Status updates to **Rejected**

See the [tracking docs](https://jobops.dakheera47.com/docs/features/post-application-tracking) for setup.

---

## AI Providers

Works with the provider you already use: Atlas Cloud, LiteLLM, Codex, OpenAI, Claude, GLM/Zhipu, Google Gemini, OpenRouter, Requesty, [API Route](https://www.api-route.com/), or any OpenAI-compatible endpoint (Ollama, LM Studio, and others).

---

## Documentation

- [Documentation Home](https://jobops.dakheera47.com/docs/)
- [Self-Hosting Guide](https://jobops.dakheera47.com/docs/getting-started/self-hosting)
- [Extractor System](https://jobops.dakheera47.com/docs/extractors/overview)
- [Troubleshooting](https://jobops.dakheera47.com/docs/troubleshooting/common-problems)

---

## Contributing

Extractor contributions — especially for other Azerbaijani or regional boards — are the most useful thing to add here. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md), or open an issue naming the board you want supported.

---

## Relationship to Upstream

This is a fork of [DaKheera47/job-ops](https://github.com/DaKheera47/job-ops) tracking `main`. Local additions are kept as separate linear commits so upstream changes merge cleanly.

```bash
git fetch origin          # upstream
git merge origin/main     # bring in upstream changes
git push fork main        # back up to this fork
```

Rollback points are tagged: `pre-glorri`, `jobsearch-integrated`, `jobsearch-city-fix`.

**Note on secrets:** `.gitignore` is hardened for `.env.*` variants, private keys, certificates, SQLite databases, and extractor auth state. This repository is public — never commit credentials. If one is ever committed, rotate the key; deleting the file is not enough, since it stays in git history.

---

## Special Thanks

- [JobOps](https://github.com/DaKheera47/job-ops) by [Shaheer Sarfaraz](https://github.com/DaKheera47) — the upstream project
- [jobspy](https://github.com/Bunsly/JobSpy) — multi-source job scraping library powering the jobspy extractor

---

## License

**AGPLv3 + Commons Clause** — inherited from upstream.

You can self-host, use, and modify JobOps freely. You cannot sell the software itself or offer paid hosted services whose value substantially comes from JobOps. See [LICENSE](./LICENSE).
</content>