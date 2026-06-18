# Stocktake Workflow

Use this when an operator is physically counting products and wants an agent to
enter counts into Retail Express. The workflow sets the outlet once, accepts
absolute counted quantities, calculates variances from current stock, and
submits a Retail Express stocktake awaiting manual authorisation.

## One-Time Setup

WMS configuration is a mandatory prerequisite for daily counting. Configure it
on the profile you will use before running `rex stocktake begin`.

Get these WMS details from Retail Express support or the account admin:

- WMS client GUID
- WMS service URL
- WMS username and password
- Retail Express user id for stocktake submissions
- Confirmation that the Web Services Interface licence is enabled

Use a separate tenant-scoped profile for each Retail Express tenant. Stocktake
sessions and WMS credentials are stored per profile, so reusing a profile across
tenants can carry stale state forward. See the
[README Stocktake section](../../README.md#stocktake) for the tenant isolation
guidance.

Profile names may contain letters, numbers, dot, underscore, and hyphen. Valid
examples: `mile-end`, `mile_end`. Invalid examples: `mile end`, `tenant/one`;
these are rejected with `Unsafe profile name for filesystem path`.

Store the WMS details on the existing profile:

```bash
rex config wms default \
  --client-id <wms-client-guid> \
  --username <wms-user> \
  --password <wms-password> \
  --url <wms-service-url> \
  --stocktake-user-id <rex-user-id>
```

## Daily Counting

Start one session for the outlet:

```bash
rex stocktake begin --outlet "Mile End"
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
credential, and URL problems appear on `rex stocktake submit`.

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
