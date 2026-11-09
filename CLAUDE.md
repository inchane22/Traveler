# Traveler: calendario de fiestas con actualización por IA

Spec: `PRD.md` (Spanish). Work milestone by milestone (H0..H7, section «Plan de entrega»);
a milestone closes only when its tests are green.

## Rules (from PRD «Reglas para CLAUDE.md»)

- The Anthropic API key never goes in client files or in the repo. Locally it is passed with
  `op run --env-file=.env.op -- <cmd>`; in CI it is the `ANTHROPIC_API_KEY` Actions secret.
- Every new date or figure carries a source; without one it is «por anunciar» or «por medir».
- Dates are local civil days with their IANA zone. Never `new Date("YYYY-MM-DD")`: use the
  helpers in `src/dates.ts` (`parseISODate`, `toISODate`, UTC-only arithmetic).
- No visible text outside `locales/`.
- Tests first for `src/dates.ts` and `src/score.ts`; every new screen gets an e2e + axe test.
- External data is rendered with `textContent` (or the `h()` helper), never `innerHTML`.
- The pipeline applies accepted changes without human review (2026-11-09); anything doubtful is
  held, never applied. Keep it that way: a new kind of risky change goes in `holdRisky`
  (scripts/lib/autoapprove.ts), and a country reaches «publicado» only through `readiness`.
- Lifecycles have one home (docs/architecture.md «State machines»). For behaviour (does an edition
  take place, is it settled, do calendars keep it) ask `STATUS_TRAITS` in `src/status.ts`; compare a
  status string only for its own wording or style. Move «Cerca de mí» only through `nextGeo` and
  load screen data only through `resource`.

## Commands

```bash
pnpm dev            # Vite dev server
pnpm test           # Vitest (unit + recorded-response pipeline tests)
pnpm typecheck      # tsc --noEmit
pnpm build          # data + calendars + Vite build, then secret scan of dist/
pnpm e2e            # Playwright + axe against the built site
pnpm pipeline -- --plan                # today's plan (budget, checks, builds), no API call
pnpm refresh -- --dry-run              # one verification run by hand, writes proposals/
pnpm onboard -- --country=PE --dry-run # country onboarding draft
```

Scripts run on Node's native type stripping: relative imports keep the `.ts` extension and
only erasable TS syntax is allowed (no enums, no parameter properties).

## Layout

- `src/` app (vanilla TS, no UI framework), `src/core/` pure logic shared with `scripts/`.
- `data/countries/<cc>.json` one file per country; `data/index.json` is generated.
- `data/state/` pipeline state: `ledger.jsonl` (one line per API call, append only),
  `requests.json` (countries asked for), `holds.json` (changes the checks held back).
- `config/` scoring weights, official domains, source tiers.
- `scripts/` refresh, onboard, build steps; `scripts/lib/` pipeline logic behind a client
  interface so tests replay recorded API responses without network.
