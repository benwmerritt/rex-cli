# The auth token endpoint is GET (the docs are wrong), token cached to disk

The official Retail Express docs, dltHub, and Airbyte all describe the token
endpoint as `POST /v2/auth/token`. Against the live API that returns a gateway
404; the working call is **`GET https://api.retailexpress.com.au/v2/auth/token`**
with an `x-api-key` header. Auth lives on `/v2` even though the data API is
`/v2.1`. Because each CLI invocation is a fresh process, the 60-minute bearer
token is cached to disk per profile (atomic write, refreshed within 5 min of
expiry) so successive commands don't each pay an auth round-trip — which also
counts against the rate budget.
