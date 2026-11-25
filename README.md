# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Luxvoo/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Luxvoo/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Pre-token protocols ranked by implied token value — a radar that prices the next token launch from TVL, 7-day growth and age, with concrete farm plans and a sortable, filterable dashboard.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=luxvoo&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## The model (radar-2)

Implied value follows only from the snapshot's own figures:

- **Peer multiple**: for each category, the median market-cap-to-TVL ratio of the
  live-token protocols in that category, shrunk toward the global median (0.246) so a
  category with one or two live peers cannot set a wild multiple, then clamped to
  0.08–0.80. Categories with no live peers use the global median.
- **Base** = `tvl_usd x peer_multiple`
- **Growth** = `clamp(change_7d, -50, 80)`; multiplier `1 + growth/100 x 0.4`
- **Maturity** = `0.7 + min(age_days, 1095)/1095 x 0.3` (unknown age: 365 days)
- **Breadth** = `1 + 0.02 x min(chains - 1, 5)`
- **Implied** = `round(base x growth x maturity x breadth)`

No protocol name is special-cased. The board covers all 40 watchlist slugs plus 186
early pre-token protocols below the $50M floor (226 rows). Live-token protocols are set
aside with their market caps shown, never mixed into the ranking. Each row carries a
6-step farm plan derived from its category, chains, TVL and age, with cost and time
per step.

## Run locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and
`out/dossier.json`. Node 22+ (type-stripping, standard library only, no install).

## Screenshots

Taken headlessly with Chrome for Testing 159.0.8154.6 at 1440x900:

- `1-board.png` — the board
- `2-detail.png` — detail view of rank 1 (Steakhouse Financial)
- `3-filtered.png` — board filtered to Lending (14 rows)

## Validation

The kit's `grade-local` cannot grade this competition locally: it is a program/v1
competition whose scorer and reference data are not published in the kit (the house
grades it server-side). Instead, `tools/gate-check.py` replicates all 7 gate checks
from RULES.txt against `out/` (dashboard files, board file, sort order, watchlist
coverage, farm steps, screenshots, dossier size). All 7 pass. The dossier was also
verified byte-identical to a fresh `buildDossier` run, and the dashboard's
recomputation of implied value matches `board.json` for all 226 rows.

## Layout

- `main.ts` — entry point (follows the starter's shape)
- `lib/model.ts` — radar-2 model, board builder, farm plans
- `vendor/makefun-board.ts` — make.fun dossier library (vendored, unchanged)
- `dashboard/` — static page, no network (index.html, app.css, app.js; 32,542 bytes
  total, under the 64 KB the judge reads whole)
- `screenshots/` — the 3 screenshots above
- `out/` — local build output (git-ignored)
