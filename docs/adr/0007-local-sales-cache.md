# Sales stats from a local cache, not live API scans

Sales reports (`rex sales`) compute from a **local per-profile SQLite cache** of
orders, not from live API calls per question. The REST API has no server-side
aggregation and — probed live (2026-07-23, `GET /orders?<param>=2026-07-01`
against v2.1, judged by whether `total_records` shrank) — no date filtering
either: `created_on_min`, `min_created_on`, `created_on_from`, `date_from`,
`start_date`, and `created_after` are all silently ignored. Re-run that probe
before relying on any new date parameter the API may grow. With 167k orders at 250/page against a
shared 250 req/min budget, a whole-account scan is ~670 requests (~3 min of the
budget); even a single-FY report — orders sort ascending by `created_on`, so the
start can be binary-searched — is ~a minute of paging re-paid on every follow-up.

`modified_since` **does** work on `/orders` (verified live) and also catches
later edits to already-synced orders, so a watermarked incremental sync is
sound: `rex sales sync` pages `modified_since` forward from the last watermark
and upserts. The first sync is ~20 min; every one after is seconds. Reports then
run as local SQL over the store-local calendar.

The trade-offs are accepted: **staleness** — mitigated by embedding
`synced_at`/`stale_hours` in every result and letting `--max-stale <hours>`
hard-fail (exit 9) rather than quote old numbers as current; a **new state
artifact** under `~/.local/state/rex/`; and the one-time first-sync cost.
Rejected the alternative of binary-searching the ascending `created_on` ordering
per query: it locates a date window in ~log₂(167k)≈18 requests but still pages
the whole window live on every question, re-pays that cost each time, computes
no aggregates, and breaks the moment default ordering changes — a cache pays the
scan once and answers every subsequent question locally.
