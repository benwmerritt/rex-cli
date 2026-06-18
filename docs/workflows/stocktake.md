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

## Daily Counting

Start one session for the outlet:

```bash
rex stocktake begin --outlet "Mile End"
```

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
rex stocktake remove <product-id>
```

Discard the whole local session:

```bash
rex stocktake abort
```

If a product name is ambiguous, use the product id or barcode instead of the
name.
