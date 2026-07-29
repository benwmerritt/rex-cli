# Stocktake Workflow

Use this when an operator is physically counting products and wants an agent to
enter counts into Retail Express. The workflow sets the outlet once, accepts
absolute counted quantities, calculates variances from current stock, and
submits a Retail Express stocktake awaiting manual authorisation.

## What Needs Which Credential

`rex` uses two unrelated credential sets. The REST API key covers the whole
catalogue, including the live stock figures a count is measured against. WMS
SOAP covers exactly one thing: creating the stocktake in Retail Express.

Run `rex doctor` to see which are configured on the active profile and which
workflows each unlocks:

```bash
rex doctor
```

| Step | Needs |
| --- | --- |
| `stocktake begin --local`, `count`, `review`, `export` | REST API key |
| `--dry-run stocktake submit` | REST API key |
| `stocktake begin`, `stocktake submit` | REST API key + WMS SOAP + user id |

## One-Time Setup

Get these WMS details from Retail Express support or the account admin. They
cannot be derived from the API key or looked up through the REST API:

- WMS client GUID
- WMS service URL
- WMS username and password
- Retail Express user id for stocktake submissions
- Confirmation that the Web Services Interface licence is enabled

If any are missing, `rex stocktake begin` reports which ones and points at
`--local` so counting can proceed while you chase them — see
[Counting Without WMS](#counting-without-wms).

Use a separate tenant-scoped profile for each Retail Express tenant. Stocktake
sessions and WMS credentials are stored per profile, so reusing a profile across
tenants can carry stale state forward. See the
[README Stocktake section](../../README.md#stocktake) for the tenant isolation
guidance.

Profile names may contain letters, numbers, dot, underscore, and hyphen. Valid
examples: `north-store`, `north_store`. Invalid examples: `north store`,
`tenant/one`; these are rejected with `Unsafe profile name for filesystem path`.

Store the WMS details on the existing profile. The four credential flags each
fall back to their `REX_WMS_*` environment variable, which is the safer route —
a password passed as a flag is visible to `ps` and recorded in shell history.
`--stocktake-user-id` has no such fallback and must be passed as a flag:

```bash
read -rsp 'client id: ' REX_WMS_CLIENT_ID; echo
read -rsp 'username:  ' REX_WMS_USERNAME;  echo
read -rsp 'password:  ' REX_WMS_PASSWORD;  echo
read -rsp 'wms url:   ' REX_WMS_URL;       echo
export REX_WMS_CLIENT_ID REX_WMS_USERNAME REX_WMS_PASSWORD REX_WMS_URL

rex config wms default --stocktake-user-id <rex-user-id>
unset REX_WMS_CLIENT_ID REX_WMS_USERNAME REX_WMS_PASSWORD REX_WMS_URL
```

The values are then stored in `~/.config/rex/config.toml` (mode 0600).

## Counting Without WMS

If the WMS credentials aren't available yet, `begin` refuses and says exactly
what is missing, where it comes from, and what still works:

```json
{"error":{"code":"validation",
  "message":"WMS SOAP credentials are not configured. This credential set is separate from the REST API key and cannot be derived from it.",
  "details":{"missing":["wms_client_id / REX_WMS_CLIENT_ID","..."],
             "source":"Request from Retail Express support ...",
             "stillAvailable":["rex stocktake begin --local — ...","..."]}}}
```

`--local` starts a count-only session. Everything except the submit works:

```bash
rex stocktake begin --outlet "Example Outlet" --local
rex stocktake count 124001 6
rex stocktake review              # submit.available is false, with the reason
rex --dry-run stocktake submit    # variance preview; needs the API key, not WMS
rex stocktake export              # worksheet to type into the Retail Express UI
rex stocktake abort               # after the adjustments are entered by hand
```

`export` splits the count into `adjustments` (non-zero variance, needs action)
and `alreadyMatching`, so only the lines that changed get retyped.

A local session cannot be submitted later, even once WMS credentials are
configured — it never recorded which WMS tenant it belonged to, and the
[tenant isolation](#one-time-setup) guarantee depends on that binding. Begin a
fresh session to submit.

`--user-id` is not required in local mode, because nothing is attributed.

## Daily Counting

Start one session for the outlet:

```bash
rex stocktake begin --outlet "Example Outlet"
```

`--user-id` is optional only when `stocktake_user_id` was configured with
`rex config wms <profile> --stocktake-user-id <rex-user-id>`; otherwise pass
`--user-id <rex-user-id>` when beginning the session.

Then count products as the operator says them:

```bash
rex stocktake count 124001 6
rex stocktake count weber q 2200 3
```

The last value is the counted quantity. If the same product is counted again,
the staged line is updated.

If a product name is ambiguous, use the product id or barcode instead:

```json
{"error":{"code":"validation","message":"Product \"weber q\" is ambiguous.","details":{"matches":[...]}}}
```

```bash
rex stocktake count 124001 3
rex stocktake count 9312924000000 3
```

## Review And Dry Run

Review the staged lines:

```bash
rex stocktake review
```

Preview the WMS submit payload without sending it:

```bash
rex --dry-run stocktake submit
```

Check the calculated variances before submitting. Example: if current stock is
8 and the count is 6, the submitted variance is `-2`.

Only non-zero variances are submitted to WMS. Zero-variance lines remain visible
in local review, but are skipped during submission.

## Submit

Submit only after the dry run looks right:

```bash
rex stocktake submit
```

This creates a Retail Express stocktake in awaiting-authorisation state. It does
not replace the manual Retail Express approval step.

### Troubleshooting

If WMS submit fails after a clean dry run, check the WMS setup first: the Web
Services Interface licence may not be enabled, credentials may be invalid, the
WMS URL may be unreachable, or the required licence may be missing. A dry run
only verifies local product, inventory, and variance calculation; WMS licence,
credential, stocktake user id, and URL problems appear on
`rex stocktake submit`.

Timeouts and network failures do not prove the SOAP request failed to reach WMS.
Before retrying, check Retail Express for an awaiting-authorisation stocktake.
If it is unclear whether WMS processed the request, contact support before
resubmitting to avoid duplicates.

## Recovery

Remove one staged line:

```bash
rex stocktake remove <line-id>
```

The value can be the staged line id or product id.

Discard the whole local session:

```bash
rex stocktake abort
```

If a product name is ambiguous, use the product id or barcode instead of the
name.
