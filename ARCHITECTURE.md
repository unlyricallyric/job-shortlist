# Project map and operational memory

## Surfaces

| Surface | Responsibility |
| --- | --- |
| `docs/` | Dependency-free read-only Chinese site; GitHub Pages serves `main:/docs` |
| `docs/model.mjs` | Strict snapshot schema, source URLs, filtering and Shanghai-date views |
| `docs/app.mjs` | Safe text-node rendering; no accounts, applications, trackers or browser storage |
| `scheduler/cli.mjs` | Installed collection, review, publication, pause/resume and status commands |
| `scheduler/runner.mjs` | One bounded execution under the local kernel mutex; no overlapping runs |
| `scheduler/browser.mjs` | Ordinary-Chrome AppleScript access, exact query/card/detail identity guards |
| `scheduler/candidates.mjs` | Source-only candidates, private exclusions, deduplication and retained selections |
| `scheduler/role-exclusions.mjs` | Versioned occupational exclusions; specialized technical/function matchers |
| `scheduler/review.mjs` / `full-review.mjs` | Material-evidence approval and exact-snapshot human withdrawal gates |
| `scheduler/publish*.mjs` | Isolated Git clone, exact dataset-only commits, durable pending receipts, Pages byte confirmation |
| `scheduler/migration.mjs` | Offline allowlisted encrypted export/restore, separate from the running worker |
| `tests/` | Built-in Node tests, synthetic source fixtures and lightweight DOM doubles |

The normal pipeline is **bounded source cards → private evidence/ledger →
sanitized candidates → isolated publication → exact public-byte confirmation**.
The private queue preserves current full-JD revisions and human decisions; it
does not block candidate visibility. Explicit ID rejection is stronger than
historical approval. Type exclusions target occupations and owned responsibilities,
not product vocabulary or the employer's industry.

## Persistent state

The private runtime normally resides at
`~/Library/Application Support/job-shortlist`; directories are `0700`, files
`0600`. `matching.json` records confirmed/unknown facts; `intent-policy.json`
records direction separately. `manual-exclusions.json`, versioned role policy
and history, `review-queue.json`, `ledger.json` and `read-history.json` retain
decisions and sampling continuity. `state.json` separates the last attempt,
last completed collection and last confirmed publication.

The website remains the published snapshot, not a real-time daemon dashboard.
`firstSeen` / `lastSeen` are observations. `firstPublishedAtById` is first public
display, falling back to `firstSeen` for legacy records. `isNew` is a publication
batch flag, not today's cumulative count. Migration keeps these facts unchanged.

## Known limits

- Only bounded samples are examined; this is not market-wide coverage, a
  guaranteed supply of new jobs, model training or qualification verification.
- An unread/short/conflicting JD stays explicitly card-only. Unknown salary is
  not decoded by guessing. Raw descriptions and private reasoning are never
  included in the public site.
- macOS, an ordinary Chrome login, Apple Events permissions, network access and
  an awake user session are prerequisites. Closed lid, manual sleep, logout,
  CAPTCHA and unavailable source pages are not bypassed.
- The schedule is explicitly Shanghai `09:30 / 12:30`. Resume begins at the next
  future slot rather than replaying every paused slot. One writer machine only.
- A subprocess timeout/descendant-pipe issue was fixed; that does **not** establish
  the cause or resolution of intermittent freezes in a host application.
- A migration package is a historical snapshot of necessary state, not a backup
  of all conversations, all prior run folders, browser login or machine setup.
  Native collection/installation is supported Mac-to-Mac only.

For operational commands see [scheduler/README.md](scheduler/README.md).
For a machine handoff and the encrypted format see
[scheduler/MIGRATION.md](scheduler/MIGRATION.md).
