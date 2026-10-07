// Trip Line — a deterministic circuit-breaker incident simulator.
// A storefront service calls a recommendations dependency through a fixed
// worker pool. Kill the dependency with no protection and calls park on dead
// sockets until the pool saturates and every request times out — a cascading
// failure. Flip the breaker on and the same kill trips open, fails fast to a
// cached fallback, and half-open probes restore service when the dependency
// heals. One tick is one fixed step: no wall clock, no randomness, so the UI,
// the CLI, the tests, and the article GIF all replay the identical incident.

export const BREAKER_STATES = ['closed', 'open', 'half-open'];
export const DEPENDENCY_MODES = ['healthy', 'slow', 'dead'];
export const PROTECTION_MODES = ['none', 'breaker'];
export const RETRY_POLICIES = ['none', 'immediate'];

export const DEFAULT_CONFIG = {
  tickMs: 100,            // one simulated step
  arrivalRps: 30,         // new requests per second of simulated time
  poolSize: 12,           // worker slots the caller owns
  callTimeoutTicks: 20,   // a call that cannot resolve dies here (2 s)
  healthyLatencyTicks: 2, // healthy dependency answers in 200 ms
  slowLatencyTicks: 15,   // degraded dependency answers in 1.5 s
  failureThreshold: 5,    // consecutive failures that trip the breaker open
  resetTimeoutTicks: 40,  // how long the breaker stays open (4 s)
  halfOpenProbes: 2,      // trial calls before the breaker closes again
  maxRetries: 3,          // attempts per request under the 'immediate' policy
  retryGapTicks: 6,       // aggressive clients retry while the first call hangs
  maxQueue: 2000,         // bounded backlog — overflow is refused (dropped)
};

// The scripted incident: baseline, kill, heal. The Replay button, the CLI,
// the tests, and the article GIF all run this same step list.
export const SCENARIOS = {
  killRecover: [
    { label: 'baseline traffic', ticks: 10 },
    { label: 'dependency dead', dependencyMode: 'dead', ticks: 60 },
    { label: 'dependency healed', dependencyMode: 'healthy', ticks: 80 },
  ],
  slowBurn: [
    { label: 'baseline traffic', ticks: 10 },
    { label: 'dependency slow', dependencyMode: 'slow', ticks: 60 },
    { label: 'dependency healed', dependencyMode: 'healthy', ticks: 40 },
  ],
};

// Timeouts arrive in waves one callTimeoutTicks apart — the window must span
// a full wave or the flag would flicker off between bursts mid-cascade.
const CASCADE_WINDOW_TICKS = DEFAULT_CONFIG.callTimeoutTicks;
const MAX_EVENTS = 200;

const latencyFor = (mode, config) =>
  mode === 'dead' ? Infinity : mode === 'slow' ? config.slowLatencyTicks : config.healthyLatencyTicks;

function assertMember(list, value, what) {
  if (!list.includes(value)) throw new RangeError(`${what} must be one of ${list.join(', ')} — got ${value}`);
}

function log(lab, kind, detail) {
  lab.events.push({ tick: lab.tick, kind, detail });
  if (lab.events.length > MAX_EVENTS) lab.events.splice(0, lab.events.length - MAX_EVENTS);
}

export function createLab(overrides = {}) {
  const { protection = 'none', retryPolicy = 'none', dependencyMode = 'healthy', ...configOverrides } = overrides;
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  for (const key of ['poolSize', 'callTimeoutTicks', 'failureThreshold', 'resetTimeoutTicks', 'halfOpenProbes']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  const lab = {
    config,
    tick: 0,
    dependencyMode: 'healthy',
    protection: 'none',
    retryPolicy: 'none',
    waiting: [],   // requests parked, holding no worker yet {id, attempts}
    active: [],    // calls holding a pool slot {id, age, latency, attempts, probe}
    requests: new Map(), // id -> {callsMade, retryAt|null}; deleted on resolve
    nextRequestId: 0,
    completed: 0,
    timedOut: 0,
    fallbacks: 0,
    dropped: 0,
    latencyTotal: 0,
    latencyCount: 0,
    timeoutLog: [], // tick number of each timed-out call
    breaker: { state: 'closed', consecutiveFailures: 0, openUntilTick: 0, probesOk: 0, probesInFlight: 0 },
    events: [],
  };
  setDependencyMode(lab, dependencyMode);
  setProtection(lab, protection);
  setRetryPolicy(lab, retryPolicy);
  return lab;
}

export function setDependencyMode(lab, mode) {
  assertMember(DEPENDENCY_MODES, mode, 'dependencyMode');
  if (lab.dependencyMode === mode) return lab;
  lab.dependencyMode = mode;
  log(lab, `dep-${mode}`, mode === 'dead' ? 'dependency killed — calls park on dead sockets' : mode === 'slow' ? `dependency degraded — ${lab.config.slowLatencyTicks}-tick latency` : 'dependency healed');
  return lab;
}

export function setProtection(lab, mode) {
  assertMember(PROTECTION_MODES, mode, 'protection');
  if (lab.protection === mode) return lab;
  lab.protection = mode;
  if (mode === 'none') {
    // Disarming resets the state machine — a stale open breaker would keep
    // shedding calls that should now reach the dependency.
    for (const call of lab.active) call.probe = false;
    lab.breaker = { state: 'closed', consecutiveFailures: 0, openUntilTick: 0, probesOk: 0, probesInFlight: 0 };
  }
  log(lab, `protection-${mode}`, mode === 'breaker' ? 'circuit breaker armed' : 'protection off — every call reaches the dependency');
  return lab;
}

export function setRetryPolicy(lab, policy) {
  assertMember(RETRY_POLICIES, policy, 'retryPolicy');
  if (lab.retryPolicy === policy) return lab;
  lab.retryPolicy = policy;
  log(lab, `retry-${policy}`, policy === 'immediate' ? `immediate retries — unanswered requests resend every ${lab.config.retryGapTicks} ticks` : 'no retries');
  return lab;
}

function tripOpen(lab, why) {
  const b = lab.breaker;
  b.state = 'open';
  b.openUntilTick = lab.tick + lab.config.resetTimeoutTicks;
  b.probesOk = 0;
  log(lab, 'open', `${why} — failing fast to the cached fallback for ${lab.config.resetTimeoutTicks} ticks`);
}

export function tick(lab) {
  const c = lab.config;
  const b = lab.breaker;
  lab.tick += 1;

  // Breaker timer: open expires into half-open trial mode.
  if (b.state === 'open' && lab.tick >= b.openUntilTick) {
    b.state = 'half-open';
    b.probesOk = 0;
    log(lab, 'half-open', `probing the dependency — ${c.halfOpenProbes} healthy call${c.halfOpenProbes === 1 ? '' : 's'} closes the breaker`);
  }

  // Due retries fire: under 'immediate' the client resends retryGapTicks after
  // its last send — whether or not any attempt has a worker, let alone an
  // answer. A request that resolves first is deleted, suppressing its retries:
  // aggressive retry costs nothing while the dependency is healthy.
  if (lab.retryPolicy === 'immediate') {
    for (const [id, req] of lab.requests) {
      if (req.retryAt !== null && req.retryAt <= lab.tick) {
        if (req.callsMade <= c.maxRetries && lab.waiting.length < c.maxQueue) {
          lab.waiting.push({ id, attempts: req.callsMade + 1 });
          req.callsMade += 1;
          req.retryAt = lab.tick + c.retryGapTicks;
        } else {
          req.retryAt = null;
        }
      }
    }
  }

  // Arrivals: open and half-open breakers fail fast — the work never parks.
  const arrivals = Math.round((c.arrivalRps * c.tickMs) / 1000);
  for (let i = 0; i < arrivals; i++) {
    if (b.state === 'closed') {
      if (lab.waiting.length >= c.maxQueue) { lab.dropped += 1; continue; }
      const id = ++lab.nextRequestId;
      lab.requests.set(id, {
        callsMade: 1,
        retryAt: lab.retryPolicy === 'immediate' ? lab.tick + c.retryGapTicks : null,
      });
      lab.waiting.push({ id, attempts: 1 });
    } else if (b.state === 'half-open' && b.probesInFlight < c.halfOpenProbes) {
      b.probesInFlight += 1;
      lab.active.push({ id: null, age: 0, latency: latencyFor(lab.dependencyMode, c), attempts: 1, probe: true });
    } else {
      lab.fallbacks += 1;
    }
  }

  // Admit waiting requests into free pool slots (closed breaker only — an
  // open breaker never lets a call near the dependency).
  while (b.state === 'closed' && lab.waiting.length && lab.active.length < c.poolSize) {
    const entry = lab.waiting.shift();
    lab.active.push({ id: entry.id, age: 0, latency: latencyFor(lab.dependencyMode, c), attempts: entry.attempts, probe: false });
  }

  // Advance every in-flight call. A call keeps the dependency mode it was
  // admitted under: a parked dead socket does not revive when the pod heals.
  const stillActive = [];
  for (const call of lab.active) {
    call.age += 1;
    if (call.age >= call.latency) {
      lab.completed += 1;
      lab.latencyTotal += call.latency;
      lab.latencyCount += 1;
      if (call.probe) {
        b.probesInFlight = Math.max(0, b.probesInFlight - 1);
        if (b.state === 'half-open') b.probesOk += 1;
      } else {
        b.consecutiveFailures = 0;
        lab.requests.delete(call.id); // resolved — suppress any pending retry
      }
      continue;
    }
    if (call.age >= c.callTimeoutTicks) {
      lab.timedOut += 1;
      lab.timeoutLog.push(lab.tick);
      lab.latencyTotal += c.callTimeoutTicks;
      lab.latencyCount += 1;
      if (call.probe) {
        b.probesInFlight = Math.max(0, b.probesInFlight - 1);
        tripOpen(lab, 'probe timed out');
      } else {
        b.consecutiveFailures += 1;
        const req = lab.requests.get(call.id);
        if (req && req.callsMade > c.maxRetries) lab.requests.delete(call.id); // no retries left to fire
        if (lab.protection === 'breaker' && b.state === 'closed' && b.consecutiveFailures >= c.failureThreshold) {
          tripOpen(lab, `${b.consecutiveFailures} consecutive failures`);
        }
      }
      continue;
    }
    stillActive.push(call);
  }
  lab.active = stillActive;

  // A tripped breaker sheds the backlog fast instead of letting it park.
  if (b.state !== 'closed' && lab.waiting.length) {
    for (const entry of lab.waiting) lab.requests.delete(entry.id);
    lab.fallbacks += lab.waiting.length;
    lab.waiting.length = 0;
  }

  // Enough clean probes → the breaker trusts the dependency again.
  if (b.state === 'half-open' && b.probesOk >= c.halfOpenProbes) {
    b.state = 'closed';
    b.consecutiveFailures = 0;
    log(lab, 'closed', `${c.halfOpenProbes} probes healthy — breaker closed, full traffic restored`);
  }

  return lab;
}

export function metrics(lab) {
  const c = lab.config;
  const b = lab.breaker;
  const resolved = lab.completed + lab.timedOut;
  return {
    tick: lab.tick,
    inFlight: lab.waiting.length + lab.active.length,
    waiting: lab.waiting.length,
    poolUsed: lab.active.length,
    poolSaturation: lab.active.length / c.poolSize,
    completed: lab.completed,
    timedOut: lab.timedOut,
    fallbacks: lab.fallbacks,
    dropped: lab.dropped,
    avgLatencyTicks: lab.latencyCount ? lab.latencyTotal / lab.latencyCount : 0,
    errorRate: resolved ? lab.timedOut / resolved : 0,
    breakerState: b.state,
    consecutiveFailures: b.consecutiveFailures,
    openUntilTick: b.openUntilTick,
    dependencyMode: lab.dependencyMode,
    protection: lab.protection,
    retryPolicy: lab.retryPolicy,
  };
}

// The failure flag the UI and tests share: workers saturated AND calls timing
// out AND requests still piling in behind them. A tripped breaker sheds the
// backlog to fallbacks, so a contained degradation never satisfies all three.
export function isCascading(lab) {
  const saturated = lab.active.length / lab.config.poolSize >= 0.9;
  const recentTimeouts = lab.timeoutLog.filter(t => t > lab.tick - CASCADE_WINDOW_TICKS).length;
  return saturated && recentTimeouts > 0 && lab.waiting.length > 0;
}

// Run a named step list ({label, dependencyMode?, protection?, retryPolicy?,
// ticks}) and snapshot metrics after every tick.
export function runScenario(lab, steps) {
  const snapshots = [];
  for (const step of steps) {
    if (step.dependencyMode) setDependencyMode(lab, step.dependencyMode);
    if (step.protection) setProtection(lab, step.protection);
    if (step.retryPolicy) setRetryPolicy(lab, step.retryPolicy);
    for (let i = 0; i < (step.ticks ?? 1); i++) {
      tick(lab);
      snapshots.push({ ...metrics(lab), label: step.label, cascading: isCascading(lab) });
    }
  }
  return snapshots;
}
