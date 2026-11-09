# Architecture and contracts

Shared contract for everyone touching this repo. `src/schema.ts` is the source of truth for data
shapes; this file fixes the interfaces between modules that are built in parallel.

## Modules

| Path | Owner area | Notes |
| --- | --- | --- |
| `src/schema.ts` | core | zod schemas. Do not loosen; extend only with a test. |
| `src/dates.ts` | core | civil-date rule engine. `occurrenceFor`, `resolveRule`, `formatDateRange`, `todayIn`. |
| `src/score.ts` | core | `scoreFestival(inputs, config)` → `{low, high, tier, criteria}`. |
| `src/festivals.ts` | core | `buildEntries`, `isVisible(entry, scope, tier2)`, `upcoming`, `applyFilters`. |
| `src/status.ts` | core | Edition status lifecycle: `STATUS_TRAITS` (what each status means). See «State machines». |
| `src/geo.ts`, `src/resource.ts` | ui | Pure state machines for «Cerca de mí» (`nextGeo`) and screen loads (`resource`), unit-tested. |
| `src/ics.ts` | calendar | RFC 5545 output, used by the browser and by `scripts/build-calendars.ts`. |
| `src/i18n.ts`, `locales/*.json` | ui | `t(key, params)`; every visible string lives in `locales/`. |
| `src/render/**`, `src/app.ts`, `src/router.ts`, `src/store.ts`, `src/search.ts`, `src/styles/**`, `index.html`, `public/sw.js` | ui | vanilla TS, DOM built with `h()` (textContent only). |
| `scripts/build-data.ts` | core | validates `data/countries/*.json`, writes `data/index.json` and `public/data/**`. |
| `scripts/pipeline.ts`, `scripts/refresh.ts`, `scripts/onboard.ts`, `scripts/check-links.ts`, `scripts/lib/**` | pipeline | Claude API behind a client interface; tests replay recorded responses. Link checks go through a fetch interface with a fake in tests. Entry points use `isMainModule(import.meta.url)` from `scripts/lib/is-main.ts` (paths with spaces and symlinks). |
| `.github/**`, `README.md` | ops | workflows pinned by SHA; README holds the key rotation runbook. |

Core modules (`schema`, `dates`, `score`, `festivals`, `ics`) never touch the DOM or `fs`, so both the
app and Node scripts import them. Relative imports keep the `.ts` extension (Node type stripping).

## Public data served to the browser (written by build-data)

- `public/data/index.json`: `PublicIndex` from `scripts/build-data.ts`:
  `{ generated_at, countries: [{code, status, region, timezone, festivals, last_verified, share_a}], tier1: ["CO/slug"], slugs: {slug: "CO"}, requests: [{code, status: "queued"|"retry"|"gave_up", retry_after?}] }`.
  `requests` lists the countries someone asked for that are not served yet (data/state/requests.json),
  so a country page can say where its build stands; an older index without it reads as `[]`.
- `public/data/countries/<cc>.json`: the validated `CountryFile`, lowercase file name. The client
  computes scores with `config/scoring.json` (bundled via Vite JSON import).
- `public/data/changelog.json`: array of `ChangelogEntry`.
- `public/calendars/<cc>.ics`, `<cc>.en.ics`, `<cc>.pt.ics`: per-country subscription feeds.
- Drafts (`status: "borrador"`) are included only when `INCLUDE_DRAFTS=1` (`pnpm dev` sets it).
  The UI shows a «borrador» banner on them. Production builds never contain drafts.

Freshness of a country = `last_verified` in the index (latest edition verification). Stale when
older than 30 days (RF-13).

## Engine and data rules (review fixes, 2026-10-28)

- `FestivalEntry.ruleCtx` (optional): `buildEntries` attaches the whole country's `RuleContext`, and
  `applyFilters` uses it, so a `relative_to` rule resolves the same in Home, Explorar and the Ficha
  even when the referenced festival is hidden. Hand-built entries fall back to their own subset.
- `nextOccurrence`: a postponed (`aplazada`) edition without new dates stays the next occurrence
  after its old window, until the following year's edition stores dates (or a year passes). Its
  window is kept (it is the original one). `upcoming` leaves out occurrences that already ended, so
  it never reaches «Lo próximo». Cancelled editions are not held.
- Month filter (`mes=`): a festival matches every month its dates or window touch.
- `MonthDay` rejects days a month never has; a fixed `02-29` rule has no edition in a common year,
  and a `02-29` window edge falls to `02-28`. Time zones must be IANA zones the platform knows.
- Score figures: `oficial` and `prensa` need `source` (and may carry `quote`); an unsourced figure is
  `estimacion`. `build-data` also checks that `oficial` sits on config/official-domains, `prensa` on
  an A or B source, declared source tiers match config/sources, lunisolar tables reach 12 months
  ahead (R4), and a `publicado` country has `MIN_SOURCED_FESTIVALS` (3) dated A/B-sourced festivals.
  A `borrador` with no config yet (no official, A or B domain: `hasConfig`) skips the three domain
  checks, because onboarding ranked its sources with `withGovernmentFallback`; they apply again
  once config exists or the country is `publicado`. Onboarding labels a figure `oficial` on an
  official domain, `prensa` on an A or B one, and `estimacion` on a tier-C page.
- `share_a` counts an edition only when a source config/sources ranks A has a quote stating the
  stored start or end day.
- Names and city (`Identity`): one plain line, at most 120 characters, no control (`Cc`), format
  (`Cf`: bidi, zero-width, soft hyphen, word joiner, the U+E0000 tag block) or line/paragraph
  separator characters. They are fenced when they go into a research prompt. The R7 injection
  check drops `Cf` characters before matching, so they cannot split a phrase.
- The extraction call sees only citations (URL, title, cited text), never the research model's prose.
- `pnpm build` runs `scripts/check-csp.ts` (exact CSP in `dist/index.html`) before the secret scan;
  the secret scan fails closed when git cannot list files or a file cannot be read.

## State machines

Every lifecycle in the repo and where its transitions live. The explicit ones have one transition
function or table with a unit test: change behaviour there, not with a new status check elsewhere.

| Lifecycle | States | Transitions | Read through |
| --- | --- | --- | --- |
| Edition status (RF-07, R9) | `por_anunciar`, `tentativa`, `confirmada`, `aplazada`, `cancelada` | pipeline only: `statusMoveCheck` + `checkConfirmedStatus` (validate.ts), stored by apply.ts (SEQUENCE); what a status needs to be stored: `Edition` (schema.ts) | `STATUS_TRAITS` (src/status.ts): `takesPlace`, `settled`, `keepsRuleDays` |
| «Cerca de mí» (RF-14) | `off`, `asking`, `on`, `denied`, `unavailable` | `nextGeo(state, event)` (src/geo.ts); app.ts makes the browser call and feeds the answer back | `ctx.geo()`; `locationAction` / `locationProblem` in components.ts draw it the same in Ajustes and Explorar |
| Screen load | `loading` → `ready` (kept per key) or `failed` → next read loads again | `resource(key, factory)` (src/resource.ts) | `asyncView` (components.ts); «Reintentar» is a re-render |
| Refresh outcome per festival | `FestivalOutcome` (report.ts) | refresh-run.ts | `VERIFIED` record: every outcome says whether the model answered (verified count, blind check, exit code) |
| Budget level (R10) | `ok`, `warn50`, `degraded80`, `stopped` | derived from the month's spend on every read (`levelOf`), never stored | `allowedAtLevel`, the follow-up budget |
| Country request | (none) → `queued` → `live`; `queued` → `retry` (30 days) → `gave_up` (3rd short build); `retry`/`gave_up` → `queued` on a new request | `nextRequest(req, cc, event, rules)` (scripts/lib/requests.ts); an error mid-build is not an attempt | `requestsDue` (the planner), `indexRequests` (the site) |
| Link verdict (R13) | `ok`, `broken`, `unknown` | `checkLink` (links.ts); a downgrade happens once, keyed by its changelog entry | `applyLostSources` |
| Country | `borrador` → `publicado` | by the pipeline only, when `readiness` (scripts/lib/publish.ts) passes: build-data's own checks for a «publicado» country, `MIN_SOURCED_FESTIVALS` dated A/B festivals included | drafts are built only with `INCLUDE_DRAFTS=1` |
| Change approval | validate.ts verdict → `holdRisky` (autoapprove.ts) → applied / held / rejected | accepted changes apply; flagged, a moved confirmed date or a cancellation without two independent sites, and a run moving over half a country's dates are held | `data/state/holds.json` (`mergeHolds`), the «Needs a look» issue |

Implicit on purpose (small, local, covered by e2e): app.ts navigation bookkeeping (`navKind` one-shot
push/replace flag, `inAppDepth` in `history.state`, `pendingFocus`/`pendingScroll` applied by
`ctx.settled()`), the Explorar filter sheet (a local draft: «Ver N fiestas» applies it as one history
entry, closing discards), the single open sheet (sheet.ts), the `?today=` clock (simulated or live,
re-read on focus, wake and every minute) and store persistence (persistent until the device refuses
a write, then memory only).

Known gaps, found 2026-11-08 and left for their own change:

- `aplazada` with stored dates: nothing says whether they are the old or the new ones, and apply
  cannot clear dates, so a postponement the pipeline records never becomes a pending postponement
  (`isPendingPostponement` needs no start).
- Onboarding stores a `cancelada` or `aplazada` next edition as `tentativa` (it verifies the dates,
  not the status).
- R2 count: onboarding's «solo N fiestas» counts festivals with any A/B source (government
  fallback), build-data's `sourcedFestivals` needs a dated edition on a config A/B source, so the
  onboarding PR can miss the warning that build-data later enforces.
- `ReviewedChange.verdict` is stored next to `reasons` and `flags` instead of derived from them, so
  the type allows a `rejected` change without a reason.

## Test data

`data/` changes every day through the pipeline's own commits, so a test that asserts a date, a
status or a count must not read it. Behaviour tests read the frozen copy in `tests/fixtures/site/`
(countries, changelog, requests and index as of 2026-11-09): the unit helpers (`countries()`,
`country()`, `tempRepo()`) and the e2e site, which Playwright builds with
`DATA_DIR=tests/fixtures/site` (build-data and build-calendars read `DATA_DIR`, default `data`).
Only checks that must hold for any data read `data/`: the committed index matches, every file
validates, no unsourced «oficial» figure. build-data enforces those before the pipeline commits.
The site's `changelog.json` keeps only countries it serves (`publicChangelog`): a draft's changes
stay private until it goes live.

## Runtime hooks for tests

- `?today=YYYY-MM-DD` on the page URL fixes «today» and shows a «Fecha simulada» banner with a link
  back to the real date. Otherwise today is the device's civil date, re-read on wake, on focus and
  every minute, so an installed app left open overnight rolls over at local midnight.
- Hash routes: `#/` home, `#/explorar?…`, `#/pais/<cc>` (lowercase), `#/fiesta/<slug>`,
  `#/guardadas`, `#/ajustes`, `#/datos`.
- Explorer state in the hash query: `pais=co,pe&mes=2027-02,2027-03&tipo=carnaval&nivel=2&desde=2027-02-01&hasta=2027-02-10`.

## ics.ts API

```ts
type IcsStatus = "TENTATIVE" | "CONFIRMED" | "CANCELLED";
interface IcsEvent { uid: string; start: ISO; end: ISO /* inclusive civil day */; summary: string;
  description?: string; location?: string; url?: string; status: IcsStatus; sequence: number }
statusFor(s: Status): IcsStatus            // confirmada→CONFIRMED, cancelada→CANCELLED, else TENTATIVE
eventFor(entry: FestivalEntry | {festival, occurrence, country}, lang: Lang, t: Translate, siteUrl: string): IcsEvent | null
buildCalendar(events: IcsEvent[], opts: { name: string; dtstamp: string /* YYYYMMDDTHHMMSSZ */ }): string
googleCalendarUrl(e: IcsEvent): string     // https only
outlookCalendarUrl(e: IcsEvent): string
```

UID = `<slug>-<year>@traveler`. All-day: `DTSTART;VALUE=DATE`, `DTEND;VALUE=DATE` = day after `end`.
An event needs days: the occurrence's dates, or, for a cancelled or postponed edition stored without
dates (`STATUS_TRAITS[status].keepsRuleDays`), the days its rule computes, so the event subscribers
already hold updates to CANCELLED or «[Aplazada]» with the new SEQUENCE (R9, RF-18). A probable window
(«announced» rule, or a `por_anunciar` edition) has no event.
Not confirmed → summary prefixed with `t("ics.prefix.tentative")`; cancelled → `t("ics.prefix.cancelled")`;
postponed → `t("ics.prefix.postponed")`. SEQUENCE = `edition.sequence`. CRLF, 75-octet folding.

Locale keys the calendar code reads (ui adds them to every `locales/*.json`):
`ics.prefix.tentative` («[Por confirmar]»), `ics.prefix.cancelled` («[Cancelada]»),
`ics.prefix.postponed` («[Aplazada]»), `ics.description` (template with `{status}`, `{confidence}`,
`{url}`), `ics.calendarName` (template with `{country}`), `status.<status>`, `confidence.<confidence>`.

## Config files

- `config/scoring.json`: weights and thresholds.
- `config/official-domains/<cc>.json`: `{ "country": "CO", "domains": ["carnavaldebarranquilla.org", "gov.co"] }`.
  A domain matches itself and its subdomains.
- `config/sources/<cc>.json`: `{ "country": "CO", "A": [...], "B": [...], "blocked": [...] }` (R2).
- `config/advisories.json`: official travel advisory URLs per origin country and destination (R6).

## Pipeline CLI (used by the workflows)

```
pnpm pipeline -- [--plan] [--request=<cc> [--issue=<n>]] [--today=YYYY-MM-DD] [--fixtures=<dir>]
pnpm refresh -- [--dry-run] [--only=<slug>] [--country=<cc>] [--today=YYYY-MM-DD] [--fixtures=<dir>]
                [--sweep=news [--within=<days>]]
pnpm onboard -- --country=<cc> [--dry-run] [--today=YYYY-MM-DD] [--fixtures=<dir>]
node scripts/check-links.ts [--today=YYYY-MM-DD]   # R6/R13 link check; exit 1 only on 404/410
```

- `pipeline` (pipeline.yml runs it daily and on «build-country» issues): intake of the request
  (`--request`, or ISSUE_NUMBER / ISSUE_TITLE / ISSUE_BODY from an issue event, parsed by
  `countryFromIssue`; refused unless it is one of the site's 238 codes) → drafts that pass R2 go
  live (`publishReady`) → `makePlan` → news sweeps → builds → verification → holds → state files.
  `--plan` (or `--dry-run`) makes no API call and writes only the summary. Outputs in `proposals/`:
  `pipeline-<date>.json|md` (plan and summary), `commit-message.txt`, `holds.md` (body of the
  «Needs a look» issue), `issue-updates.json` (`[{issue, comment, close}]` for the workflow), plus
  each batch's report (`sweep-<date>`, `verify-<date>`, `build-<cc>-<date>`). `$GITHUB_OUTPUT`:
  `changes`, `held`, `unexpected`, `builds`, `stopped`. Exit 1 when a batch failed (budget stop,
  bad credentials, blind search) or a festival hit an unexpected error; pipeline.yml commits first.
- A build (`buildCountry`): no `config/sources/<cc>.json` → one call without web search drafts it
  (`draftSourcePolicy`: official, press, blocked; code keeps bare hostnames, always adds
  `defaultGovernmentDomains` and UNESCO, never lists social networks or resellers as press, and a
  failed call writes the government-only fallback). No country file → `runOnboard`. Then up to
  `build_topups` festivals without a sourced date, nearest first (`topUpQueue`), are verified with
  job `build`; `readiness` decides `publicado`. Short of R2 → the request retries in `retry_days`.
- Planner (`makePlan`, pure): pools from `config/pipeline.json` (`new_country_share` for builds,
  the rest for upkeep spread over the days left; in the last `release_build_pool_days` both share
  what is left, upkeep first). Cadence: `verifyInterval(daysToStart, settled, tier, stretch)` and
  `sweepInterval`; the last check per festival comes from the ledger (`lastDays`), so a check that
  found nothing is not repeated. Bands in priority order: `sweep-7`, `verify-45`, `sweep-45`,
  builds, `verify-120`, `verify-180`, `verify-far`; what does not fit today's share is deferred
  (still due tomorrow). `projection` gives the full-cadence cost per country and the stretch (1 to
  `MAX_STRETCH` = 4) applied beyond 45 days so upkeep fits. Job costs: the ledger's average once
  three jobs of a kind exist, else `default_job_usd`.
- Ledger (`data/state/ledger.jsonl`, `scripts/lib/ledger.ts`): one strict JSON line per call that
  returned: `{day, job, key, call, model, searches, input_tokens, output_tokens, usd}`; jobs
  `onboard`, `policy`, `build` (new-country pool) and `verify`, `followup`, `sweep` (upkeep).
  `call: "carryover"` brings in a total from before the ledger. Fixture runs keep it in memory.

- `--sweep=news` (R9): only festivals whose next edition starts within `--within` days (1 to 45,
  default 45), ongoing ones included, queue reason `news`. The research prompt asks for news with
  «cancelado», «aplazado», «suspendido» in the local language plus the English and Portuguese
  terms (for other languages, `LOCAL_NEWS_TERMS` plus English). Report: `sweep_within` in the JSON,
  «Barrido de noticias» heading in the Markdown. Cadence: the planner's `sweepInterval`.
- `check-links`: HEAD then GET for every whole https string in `config/advisories.json` and every
  source, archive, score source and rule table URL in `data/countries/*.json`. 2xx/3xx ok, 404/410
  broken; 401/403/418/429/5xx, network errors and bot-challenge pages are `unknown`. Every hop
  must be a public https host: IPv4 wrapped in IPv6 (mapped `::ffff:`, compatible `::`, NAT64
  `64:ff9b::`, dotted or hex) is unwrapped before the private-range check, and 6to4 (`2002::/16`)
  and site-local (`fec0::/10`) literals are refused. Writes
  `proposals/links-<date>.md` and `proposals/links-<date>.json` (`LinksReport` in
  `scripts/lib/links.ts`).
- R13 in refresh (only with `LINKS_REPORT_PATH`, a report at most 7 days old): an edition whose
  sources are all lost (original 404/410 and no `archive_url`, or a broken one) drops one
  confidence level (`applyLostSources`), with a changelog entry `field: "confidence"` listing the
  lost URLs; that entry makes the downgrade happen once. No `last_verified` or `sequence` change.
  Report: `link_downgrades`.
- Trial apply (code-F2, BE-01): before the report is written, the accepted changes are applied in
  memory; one that breaks the schema, or adds a problem build-data's `dataProblems` would report,
  is held with the message, so the rest of the run is still applied. Confidence caps in
  validation look at the source apply will store (the one holding the quote, else the first
  cited): `oficial` needs it official, and a score `prensa` on a tier-C page becomes `estimacion`.
  A score confirmation from a weaker source than the stored one changes nothing.
- Unexpected per-festival errors (a bug, not an API error; BE-04): the festival is logged as
  `error` and the run goes on; under Actions each one is a `::error::` annotation. Exit 1 when no
  festival was verified at all; otherwise refresh exits 0 so its changes are written, and the
  pipeline exits 1 afterwards when `unexpected` > 0 (pipeline.yml commits first, then goes red). Proposals are written on every run, changes or not
  (`proposals/` is the run artifact, never committed), so an empty run can be diagnosed.
- Blind search check: a weekly run where two or more festivals were researched and every one
  ended `no_citations` exits 1 with a `::error::` annotation; the search setup is broken, not the
  festivals. News sweeps are never judged this way.
- Follow-up search (R7, R2): after a pass-1 answer (official + A domains only) that cites pages but
  leaves `start` or `end` of an unconfirmed edition under 120 days out unanswered
  (`missingDateFacts`; further out the dates are rarely published yet), a pass-2
  search (block list only) asks for the missing facts only (`research-followup.md`). Its proposals
  are validated against its own citations and only the missing fields are kept; a failure keeps
  pass 1. Verification runs only (never sweeps), at most `MAX_FOLLOWUPS_PER_RUN` per run in queue
  order, and none once the month is at 80%; recorded as job `followup` (`build` inside a build).
  Report: `followup` in each festival log.
- R2 progress: `drafts` in the report lists each «borrador» country the run researched with its
  sourced festivals before and after the selected changes; at 3 it goes live at the end of the run.
- `pnpm refresh` on its own (manual runs) still builds its queue with `buildQueue` (queue.ts:
  unsettled weekly under 180 days, monthly otherwise; settled only when stale). The pipeline
  passes its planned queue instead (`RefreshOptions.queue`), with `job` and `reportName`.
  A postponed edition without new dates and a cancelled one are out of the news sweeps.
- Auto-approval (`selectForApply` + `holdRisky`): every accepted change and confirmation is
  applied, riskiest first, with no cap; flagged ones are held. A confirmation of a field the same
  run changes is dropped so apply cannot undo the change.
- Status moves (`statusMoveCheck` in validate.ts): confirmada → tentativa/por_anunciar is rejected
  unless the quote says the dates are unconfirmed; a move to cancelada/aplazada is flagged unless the
  quote says so; leaving cancelada is always flagged (an old page reads like a reinstatement).
- RF-18 in apply: an edition stored for the first time starts at `sequence` 1 when its dates or
  status differ from the rule-based event calendars already had (`firstEditionSequence`), and every
  change of dates or status still bumps it.

Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `MAX_FESTIVALS_PER_RUN`
(40), `MAX_FOLLOWUPS_PER_RUN` (6; 0 turns follow-ups off), `MONTHLY_BUDGET_USD` (20), `ARCHIVE_ACCESS_KEY` / `ARCHIVE_SECRET_KEY` (optional, R13),
`LINKS_REPORT_PATH` (optional: R13 above), `SITE_URL` (pipeline: the link in a «now live» issue
comment), `ISSUE_NUMBER` / `ISSUE_TITLE` / `ISSUE_BODY` (pipeline, from an issue event). Every
real call appends to `data/state/ledger.jsonl`, dry runs included. Outputs: `proposals/<name>.json`,
`proposals/<name>.md`, and with `$GITHUB_OUTPUT` set: refresh `changes`, `flagged`, `unexpected`
(festivals that failed with an unexpected error) and `verified` (festivals where the model
answered); onboard `changes`.

## Country facts and languages (any country)

- `countryInfo(cc)` (scripts/lib/lang.ts): the hand-checked table wins; otherwise CLDR's likely
  language and zone for `und-<cc>` plus `config/regions.json`, with `CAPITAL_ZONES` for countries
  CLDR lists several zones for. All 238 codes of `ISO_COUNTRIES` (src/search.ts) have facts.
  `lang` (prompts, es/en/pt) falls back to English; `local` is the sources' language.
- Dates (`quoteStatesDate`, date-parser.ts): es/pt/en keep their hand vocabularies (and read only
  their own months); any other language reads CLDR month names (standalone and in-date forms, long
  and short) plus English, native digits, 年月日 / 월일 dates (before folding: NFD splits Hangul) and
  Thai Buddhist-era years. `hasDateReader(lang)` is false only when the platform does not know it;
  then validate.ts flags the change («sin lector de fechas») and it is held.
- `registrableDomain` also treats generic second-level labels under any two-letter ccTLD
  (`co.jp`, `or.kr`, `gov.za`…) as suffixes, so two outlets of a new country stay independent.
