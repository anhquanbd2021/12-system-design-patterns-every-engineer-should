# Trip Line — companion demo

Interactive lab for the article *12 System Design Patterns — and the Failure
Each One Prevents*. A storefront service calls a recommendations dependency
through a fixed worker pool. Kill the dependency with protection off and watch
calls park on dead sockets until the pool saturates and every request times
out — a cascading failure, on demand. Arm the breaker and the same kill trips
open, fails fast to a cached fallback, and half-open probes restore service
when the dependency heals.

Zero dependencies — Node 24+ only. The simulation and the pattern catalog are
plain ES modules shared by the browser UI, the CLI, the test suite, and the
server's `/api/scenario` replay.

## What it proves

The circuit breaker's closed → open → half-open state machine is what decides
whether a dying dependency becomes a contained degradation or a cascading
outage. Same kill, same traffic — only the pattern differs:

- `protection: none` — pool saturates to 100%, the request queue grows, and
  every call burns `callTimeoutTicks` (2 s) before timing out.
- `protection: breaker` — after `failureThreshold` consecutive timeouts the
  breaker opens, requests fail fast to a cached fallback, the pool drains, and
  `halfOpenProbes` successful trials close it once the dependency heals.
- `retryPolicy: immediate` — the retry storm: every unanswered request resends
  every `retryGapTicks`, multiplying the backlog ~4× so the pile-up outlives
  the heal. Requests that resolve suppress their retries.

## Run it

```text
npm start          # serve the lab on http://localhost:3000
npm test           # unit + e2e: simulation, incident replay, catalog, HTTP
npm run cascade    # CLI: tick-by-tick kill/heal trace, both protection modes
npm run check      # both
```

Repo: [github.com/anhquanbd2021/12-system-design-patterns-every-engineer-should](https://github.com/anhquanbd2021/12-system-design-patterns-every-engineer-should)

## Layout

- `public/lab.mjs` — the simulation: `createLab`, `tick`, `runScenario`,
  `metrics`, `isCascading`, `SCENARIOS`
- `public/patterns.mjs` — the 12-pattern catalog the Guide tab renders
- `public/app.js` — browser glue: single-line diagram, pool strip, trace, log
- `app/server.js` — zero-dependency static host plus `/health`, `/version`,
  `/api/patterns`, `/api/scenario`
- `scripts/cascade.mjs` — the CLI incident trace
- `test/` — `node --test "test/*.test.mjs"`

## Honest limits

- Time is simulated in fixed ticks — no real network, sockets, or wall clock.
- One dependency, one pool, one breaker — real cascades fan out across hops.
- The fallback is counted, not rendered — a real cache needs its own fill path.
- "Slow" models latency below the timeout; real degradation is a spectrum.

This is an educational demo, not production infrastructure.
