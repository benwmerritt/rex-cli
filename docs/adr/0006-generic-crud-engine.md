# A generic CRUD engine instead of per-resource code

Retail Express resources are uniform (`{data, page_number, page_size,
total_records}` lists; `/resource/{id}` records), so list/get/create/update/
disable live once in `resources/crud.ts` + `commands/crud.ts`, and each resource
is a declarative `CrudSpec` (path, verbs, searchable, priceFields). Products is
the reference spec; the other ~13 resources are a few lines each. Divergences
are expressed as spec flags (`getById:false` for inventory, create-only for
transfers, `--include` for orders) rather than bespoke modules — chosen over a
worktree-per-resource fan-out because the engine made each resource trivial.
