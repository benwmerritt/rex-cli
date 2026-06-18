# Stocktake Workflow

Use this when an operator is physically counting products and wants an agent to
enter counts into Retail Express. The workflow sets the outlet once, accepts
absolute counted quantities, calculates variances from current stock, and
submits a Retail Express stocktake awaiting manual authorisation.

## One-Time Setup

Get these WMS details from Retail Express support or the account admin:

- WMS client GUID
- WMS service URL
- WMS username and password
- Retail Express user id for stocktake submissions
- Confirmation that the Web Services Interface licence is enabled

Store them on the existing profile:

```bash
rex config wms default \
  --client-id <wms-client-guid> \
  --username <wms-user> \
  --password <wms-password> \
  --url <wms-service-url> \
  --stocktake-user-id <rex-user-id>
```

If WMS submit fails after a clean dry run, check the WMS setup first: the Web
Services Interface licence may not be enabled, credentials may be invalid, the
WMS URL may be unreachable, or the required licence may be missing. A dry run
only verifies local product, inventory, and variance calculation; WMS licence,
credential, and URL problems appear on `rex stocktake submit`.

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
