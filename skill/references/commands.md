# rex command reference

_Generated from the CLI definition — do not edit by hand (run `bun run docs`)._

## Global options

| Flag | Description |
| --- | --- |
| `-V, --version` | output the version number |
| `--json` | JSON output (default) |
| `-H, --human` | human-readable tables |
| `-p, --profile <name>` | profile to use |
| `--dry-run` | compute changes without sending any write |
| `--allow-price` | permit writes to price fields |
| `--page <n>` | page number (1-based) |
| `--page-size <n>` | records per page (max 250) |
| `--all` | fetch every page (streams NDJSON) |
| `-v, --verbose` | verbose error output |

## Commands

### `rex auth login <name>`

Store an API key for a profile in config.toml (0600)

| Flag | Description |
| --- | --- |
| `--key <apiKey>` | API key (falls back to REX_API_KEY) |
| `--base-url <url>` | API base URL |
| `--api-version <v>` | data API version |

### `rex auth test`

Verify the active profile can authenticate and read

### `rex auth whoami`

Show the resolved active profile (no secrets)

### `rex auth list`

List configured profiles

### `rex auth default <name>`

Set the default profile

### `rex config path`

Print the config file path

### `rex config show`

Show the config with API keys redacted

### `rex config init`

Create a starter config.toml if none exists

### `rex config wms <profile>`

Store WMS SOAP credentials for stocktake workflows

| Flag | Description |
| --- | --- |
| `--client-id <guid>` | Retail Express WMS client GUID (or REX_WMS_CLIENT_ID) |
| `--username <name>` | Retail Express WMS username (or REX_WMS_USERNAME) |
| `--password <password>` | Retail Express WMS password (or REX_WMS_PASSWORD) |
| `--url <url>` | Retail Express WMS service URL (or REX_WMS_URL) |
| `--stocktake-user-id <id>` | Retail Express user id for stocktake submissions |

### `rex api <method> <path>`

Raw passthrough to the Retail Express API (escape hatch for un-wrapped endpoints)

| Flag | Description |
| --- | --- |
| `--data <json>` | JSON request body |
| `--data-file <file>` | read the JSON body from a file |
| `-q, --query <kv...>` | query params, key=value (repeatable) |

### `rex product list`

List products

| Flag | Description |
| --- | --- |
| `--search <q>` | full-text search |
| `--filter <kv...>` | filter_by key=value (repeatable) |
| `--include-inventory` | embed basic inventory in each product |

### `rex product get <id>`

Get a product by id

### `rex product search <query>`

Search products (shortcut for list --search)

### `rex product update [id]`

Update products: re-fetch, diff, write only changed fields

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex product create`

Create products

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex product disable <id>`

Soft-disable a product (not a hard delete)

### `rex outlet list`

List outlets

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex outlet get <id>`

Get a outlet by id

### `rex product-type list`

List producttypes

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex product-type get <id>`

Get a product-type by id

### `rex attribute list`

List productattributes

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex attribute get <id>`

Get a attribute by id

### `rex barcode list`

List productbarcodes

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex barcode get <id>`

Get a barcode by id

### `rex supplier list`

List suppliers

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex supplier get <id>`

Get a supplier by id

### `rex inventory list`

List inventory

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |
| `--modified-since <ts>` | only rows changed since an ISO timestamp |

### `rex customer list`

List customers

| Flag | Description |
| --- | --- |
| `--search <q>` | full-text search |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex customer get <id>`

Get a customer by id

### `rex customer search <query>`

Search customers (shortcut for list --search)

### `rex customer update [id]`

Update customers: re-fetch, diff, write only changed fields

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex customer create`

Create customers

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex order list`

List orders

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |
| `--include <names...>` | embed related data: items, fulfilments, payments |

### `rex order get <id>`

Get a order by id

### `rex purchase-order list`

List purchaseorders

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex purchase-order get <id>`

Get a purchase-order by id

### `rex purchase-order update [id]`

Update purchaseorders: re-fetch, diff, write only changed fields

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex purchase-order create`

Create purchaseorders

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex transfer list`

List transfers

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex transfer get <id>`

Get a transfer by id

### `rex transfer create`

Create transfers

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex loyalty-reason list`

List loyaltyadjustmentreasons

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex loyalty-reason get <id>`

Get a loyalty-reason by id

### `rex loyalty-reason update [id]`

Update loyaltyadjustmentreasons: re-fetch, diff, write only changed fields

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex loyalty-reason create`

Create loyaltyadjustmentreasons

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex loyalty-history list`

List loyaltyhistory

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex loyalty-history get <id>`

Get a loyalty-history by id

### `rex stock-reason list`

List stockadjustmentreasons

| Flag | Description |
| --- | --- |
| `--filter <kv...>` | filter_by key=value (repeatable) |

### `rex stock-reason get <id>`

Get a stock-reason by id

### `rex stock-reason update [id]`

Update stockadjustmentreasons: re-fetch, diff, write only changed fields

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex stock-reason create`

Create stockadjustmentreasons

| Flag | Description |
| --- | --- |
| `--set <kv...>` | field assignment key=value (or key:=json) |
| `--file <path>` | JSON array/object of records to write |
| `--stdin` | read NDJSON records from stdin |
| `--description-file <path>` | read long_description from a file |

### `rex stocktake begin`

Start a local stocktake session for one outlet

| Flag | Description |
| --- | --- |
| `--outlet <id-or-name>` | Retail Express outlet id or name for this stocktake |
| `--user-id <id>` | Retail Express user id for WMS stocktake submission |
| `--force` | replace an existing active stocktake session |

### `rex stocktake count <query>`

Stage an absolute counted quantity for a product

### `rex stocktake review`

Review the active stocktake session

### `rex stocktake remove <line-id>`

Remove a staged stocktake line by line id or product id

### `rex stocktake submit`

Submit the active session to WMS CreateStocktake

### `rex stocktake abort`

Discard the active local stocktake session

