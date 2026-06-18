# Write safety: partial diffs, price gate, audit, GET-only 5xx retry

Writes hit a live retail system (propagating to POS and Shopify), so:
`update` re-fetches and PUTs only changed fields (never a blind overwrite);
`--dry-run` previews any write; price-touching fields require `--allow-price`
(exit 8); `disable` is a soft-delete (no hard delete); every applied write is
appended to a local JSONL audit log. Because Retail Express has **no idempotency
key**, 5xx/network retries are GET-only — a failed POST/PUT is surfaced, never
silently retried (which could double-create).
