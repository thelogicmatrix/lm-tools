# performance-efficiency — Will this survive real input volume?
> Cites: res_code-quality.md

## Fires on
Tags: code. Any artifact containing loops, queries, or data loading over collections/DB/files.

## Attacks
- N+1 queries: looping over a result set and issuing one query/API call per row instead of a batched/joined/eager-loaded fetch.
- O(n²) hot loops: nested iteration over the same collection (`.find()`/`.includes()` inside a loop) where a set/map/index would make it linear.
- Unbounded memory: loading a full table/file/response into memory with no cap — no pagination, streaming, or LIMIT where input size isn't guaranteed bounded.
- Missing pagination/indexing: an endpoint/query returning "all rows," or a WHERE/JOIN/ORDER BY on an unindexed column at scale.
- Repeated uncached work: the same expensive call/computation re-run per iteration or per request with no memoization, on a path that's actually hot.

## Evidence of attack (clean-pass proof)
Name the hot path (function/endpoint) and its actual complexity: "loop at line X does one query per iteration → N+1" or "nested loop over list of size n → O(n²), replaced by dict lookup would be O(n)." State whether the path is hot (inner loop / per-request / unbounded input) or one-time (config parsing, startup) — flagging a cold path as a performance defect is itself a defect per the res file's premature-optimization warning.

## Severity guide
- blocker: won't scale to real input — N+1 on a user-facing list endpoint, O(n²) on unbounded input, unbounded memory load on untrusted-size data.
- should-fix: wasteful but survives at current scale (e.g., N+1 on a capped/small collection, missing index on a low-traffic query).
- nit: micro-optimization on a cold path with no measured or plausible impact.
