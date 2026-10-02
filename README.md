# HTTP Cache Lab

Local workbench for cache simulations.

Run `npm install`, then `npm run dev`.

## Capacity budget

The shared response cache accepts an optional entity-byte budget, charged on
the stored response body bytes of each variant (gzip and identity
representations cost differently). Entries are evicted least-recently-used
first; a response larger than the whole budget is served but never stored.

- `GET /api/cache` — budget, current usage and per-resource/per-variant
  breakdown (the server-side source of truth for the UI panel).
- `PUT /api/cache/budget` with `{"budgetBytes": <non-negative integer> | null}`
  — sets the budget (`null` = unbounded) and returns the variants evicted to
  satisfy it. The budget is enforced at fill commit time, so shrinking it
  while a fill is in flight still applies to that fill.

