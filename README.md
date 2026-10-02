# HTTP Cache Lab

Local workbench for cache simulations.

Run `npm install`, then `npm run dev`.

## What it simulates

- **Vary canonical keys** — mergeable request fields (e.g. `Accept-Encoding`)
  are token-normalized, non-mergeable ones (e.g. `X-Locale`) keep their exact
  value sequence; `Vary: *` bypasses the cache entirely.
- **Bounded capacity** — the running cache has an optional budget over stored
  response entity bytes (gzipped and identity variants are charged their real,
  different sizes). Eviction is global LRU across all resources; a response
  larger than the whole budget is served but never retained.
- **Revision safety** — a PUT purges all variants of the resource, and a fill
  that observed a stale revision is never stored. Concurrent equivalent
  requests share one origin fill.

## Cache API

- `GET /api/cache/stats` — authoritative state: budget, used bytes, and the
  per-variant / per-resource breakdown (most recently used first).
- `PUT /api/cache/budget` — body `{"budgetBytes": <non-negative integer>}`
  sets the budget (`null` removes it). Shrinking evicts LRU entries
  immediately; the response lists what stopped being retained.

Every `GET /api/experiments/:id` response reports its cache path:

- `X-Cache-Status` / `X-Cache-Reason` — HIT, MISS (origin-fill,
  concurrent-fill-joined, revision-updated) or BYPASS.
- `X-Cache-Miss-Cause` — why no entry was found: `cold`, `evicted-capacity`,
  `exceeds-budget` or `revision-updated`.
- `X-Cache-Retained` / `X-Cache-Retained-Reason` — whether the fill was
  stored (`exceeds-budget`, `revision-guard` when not).
- `X-Cache-Evicted` / `X-Cache-Evicted-Bytes` — evictions this fill caused.
- `X-Cache-Entry-Bytes` — stored entity size of the served variant.

`?fillDelay=<ms>` on a GET simulates origin latency for concurrency
experiments.
