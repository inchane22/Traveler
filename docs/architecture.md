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
| `src/ics.ts` | calendar | RFC 5545 output, used by the browser and by `scripts/build-calendars.ts`. |
| `src/i18n.ts`, `locales/*.json` | ui | `t(key, params)`; every visible string lives in `locales/`. |
| `src/render/**`, `src/app.ts`, `src/router.ts`, `src/store.ts`, `src/search.ts`, `src/styles/**`, `index.html`, `public/sw.js` | ui | vanilla TS, DOM built with `h()` (textContent only). |
| `scripts/build-data.ts` | core | validates `data/countries/*.json`, writes `data/index.json` and `public/data/**`. |
| `scripts/refresh.ts`, `scripts/onboard.ts`, `scripts/check-links.ts`, `scripts/lib/**` | pipeline | Claude API behind a client interface; tests replay recorded responses. Link checks go through a fetch interface with a fake in tests. Entry points use `isMainModule(import.meta.url)` from `scripts/lib/is-main.ts` (paths with spaces and symlinks). |
| `.github/**`, `README.md` | ops | workflows pinned by SHA; README holds the key rotation runbook. |

Core modules (`schema`, `dates`, `score`, `festivals`, `ics`) never touch the DOM or `fs`, so both the
app and Node scripts import them. Relative imports keep the `.ts` extension (Node type stripping).

## Public data served to the browser (written by build-data)

- `public/data/index.json`: `PublicIndex` from `scripts/build-data.ts`:
  `{ generated_at, countries: [{code, status, region, timezone, festivals, last_verified, share_a}], tier1: ["CO/slug"], slugs: {slug: "CO"} }`.
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
- `share_a` counts an edition only when a source config/sources ranks A has a quote stating the
  stored start or end day.
- Names and city (`Identity`): one plain line, at most 120 characters, no control, bidi or
  zero-width characters. They are fenced when they go into a research prompt.
- The extraction call sees only citations (URL, title, cited text), never the research model's prose.
- `pnpm build` runs `scripts/check-csp.ts` (exact CSP in `dist/index.html`) before the secret scan;
  the secret scan fails closed when git cannot list files or a file cannot be read.

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
pnpm refresh -- [--dry-run] [--only=<slug>] [--country=<cc>] [--today=YYYY-MM-DD] [--fixtures=<dir>]
                [--sweep=news [--within=<days>]]
pnpm onboard -- --country=<cc> [--dry-run] [--today=YYYY-MM-DD] [--fixtures=<dir>]
node scripts/check-trap.ts        # fails if a trap proposal (R12) is present; needs TRAP_SECRET and TRAP_FINGERPRINTS
                                  # (refresh.yml appends each month's fingerprint to that secret with the app token)
node scripts/check-links.ts [--today=YYYY-MM-DD]   # R6/R13 link check; exit 1 only on 404/410
```

- `--sweep=news` (R9): only festivals whose next edition starts within `--within` days (1 to 45,
  default 45), ongoing ones included, queue reason `news`. The research prompt asks for news with
  «cancelado», «aplazado», «suspendido» in the local language plus the English and Portuguese
  terms. A sweep never carries the R12 trap and does not count as the month's weekly run
  (`weekly_runs` in `data/usage.json`). Report: `sweep_within` in the JSON, «Barrido de noticias»
  heading in the Markdown. Workflow cadence: Monday weekly, Tuesday and Friday 45 days, other days
  7 days.
- `check-links`: HEAD then GET for every whole https string in `config/advisories.json` and every
  source, archive, score source and rule table URL in `data/countries/*.json`. 2xx/3xx ok, 404/410
  broken; 401/403/418/429/5xx, network errors and bot-challenge pages are `unknown`. Writes
  `proposals/links-<date>.md` and `proposals/links-<date>.json` (`LinksReport` in
  `scripts/lib/links.ts`).
- R13 in refresh (only with `LINKS_REPORT_PATH`, a report at most 7 days old): an edition whose
  sources are all lost (original 404/410 and no `archive_url`, or a broken one) drops one
  confidence level (`applyLostSources`), with a changelog entry `field: "confidence"` listing the
  lost URLs; that entry makes the downgrade happen once. No `last_verified` or `sequence` change.
  Report: `link_downgrades`.
- RF-18 in apply: an edition stored for the first time starts at `sequence` 1 when its dates or
  status differ from the rule-based event calendars already had (`firstEditionSequence`), and every
  change of dates or status still bumps it.

Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `MAX_FESTIVALS_PER_RUN`
(40), `MONTHLY_BUDGET_USD` (20), `ARCHIVE_ACCESS_KEY` / `ARCHIVE_SECRET_KEY` (optional, R13),
`TRAP_SECRET` (R12), `USAGE_FALLBACK_PATH` (optional, refresh and onboard: a `usage.json` from the
last run artifact; per month the higher total wins, and online runs write the merged history to
`data/usage.json` before the first call), `LINKS_REPORT_PATH` (optional, refresh: R13 above). Outputs: `proposals/<date>.json`, `proposals/<date>.md` (PR body), and with
`$GITHUB_OUTPUT` set: `changes=<n>` and `branch=refresh/<date>` (or `onboard/<cc>`).
