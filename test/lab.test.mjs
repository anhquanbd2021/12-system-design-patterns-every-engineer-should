import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKER_STATES, DEPENDENCY_MODES, PROTECTION_MODES, RETRY_POLICIES,
  DEFAULT_CONFIG, SCENARIOS,
  createLab, setDependencyMode, setProtection, setRetryPolicy,
  tick, metrics, isCascading, runScenario,
} from '../public/lab.mjs';

const run = (lab, n) => { for (let i = 0; i < n; i++) tick(lab); return lab; };

test('catalogs and defaults are exactly as specified', () => {
  assert.deepEqual(BREAKER_STATES, ['closed', 'open', 'half-open']);
  assert.deepEqual(DEPENDENCY_MODES, ['healthy', 'slow', 'dead']);
  assert.deepEqual(PROTECTION_MODES, ['none', 'breaker']);
  assert.deepEqual(RETRY_POLICIES, ['none', 'immediate']);
  assert.equal(DEFAULT_CONFIG.failureThreshold, 5);
  assert.equal(DEFAULT_CONFIG.resetTimeoutTicks, 40);
  assert.equal(DEFAULT_CONFIG.halfOpenProbes, 2);
  assert.ok(SCENARIOS.killRecover.length >= 3);
});

test('invalid modes are rejected', () => {
  const lab = createLab();
  assert.throws(() => setDependencyMode(lab, 'spicy'), RangeError);
  assert.throws(() => setProtection(lab, 'hope'), RangeError);
  assert.throws(() => setRetryPolicy(lab, 'forever'), RangeError);
  assert.throws(() => createLab({ poolSize: 0 }), RangeError);
});

test('the simulation is deterministic — same inputs, same metrics', () => {
  const a = run(createLab(), 40);
  const b = run(createLab(), 40);
  assert.deepEqual(metrics(a), metrics(b));
});

test('healthy dependency: calls complete in healthyLatencyTicks', () => {
  const lab = run(createLab(), 30);
  const m = metrics(lab);
  assert.ok(m.completed > 60, `expected steady completions, got ${m.completed}`);
  assert.equal(m.timedOut, 0);
  assert.equal(m.poolUsed, 3); // 3 arrivals/tick, each resolving next tick
  assert.equal(m.avgLatencyTicks, DEFAULT_CONFIG.healthyLatencyTicks);
});

test('unprotected dead dependency saturates the pool and cascades', () => {
  const lab = createLab({ protection: 'none' });
  setDependencyMode(lab, 'dead');
  run(lab, 10);
  assert.equal(metrics(lab).poolUsed, DEFAULT_CONFIG.poolSize); // full well before timeouts
  assert.equal(metrics(lab).timedOut, 0);                       // nothing has hit the timeout yet
  run(lab, 20);
  const m = metrics(lab);
  assert.ok(m.timedOut > 0, 'dead calls start timing out at tick 20');
  assert.ok(m.poolSaturation >= 0.9);
  assert.ok(m.waiting > 0, 'requests pile up behind the parked sockets');
  assert.equal(isCascading(lab), true);
});

test('breaker: closed → open at failureThreshold consecutive failures', () => {
  const lab = createLab({ protection: 'breaker' });
  setDependencyMode(lab, 'dead');
  let openedAt = null;
  for (let i = 0; i < 60 && openedAt === null; i++) {
    tick(lab);
    if (lab.breaker.state === 'open') openedAt = lab.tick;
  }
  assert.ok(openedAt !== null, 'breaker should trip');
  assert.ok(lab.breaker.consecutiveFailures >= DEFAULT_CONFIG.failureThreshold);
  assert.equal(lab.breaker.openUntilTick, openedAt + DEFAULT_CONFIG.resetTimeoutTicks);
});

test('breaker: open → half-open after resetTimeoutTicks, probe failure re-opens', () => {
  const lab = createLab({ protection: 'breaker' });
  setDependencyMode(lab, 'dead');
  let openedAt = null;
  for (let i = 0; i < 60 && openedAt === null; i++) {
    tick(lab);
    if (lab.breaker.state === 'open') openedAt = lab.tick;
  }
  while (lab.tick < lab.breaker.openUntilTick) tick(lab);
  assert.equal(lab.breaker.state, 'half-open'); // expiry tick flips to probing

  // Dependency still dead: probes time out and the breaker re-opens.
  let reopenedAt = null;
  for (let i = 0; i < 40 && reopenedAt === null; i++) {
    tick(lab);
    if (lab.breaker.state === 'open') reopenedAt = lab.tick;
  }
  assert.ok(reopenedAt !== null, 'dead probes should re-open the breaker');
  assert.equal(lab.breaker.openUntilTick, reopenedAt + DEFAULT_CONFIG.resetTimeoutTicks);
});

test('breaker: half-open probes close the breaker once the dependency heals', () => {
  const lab = createLab({ protection: 'breaker' });
  setDependencyMode(lab, 'dead');
  while (lab.breaker.state !== 'open') tick(lab);
  setDependencyMode(lab, 'healthy'); // heal while the breaker is open
  while (lab.breaker.state === 'open') tick(lab); // ride out the reset window
  assert.equal(lab.breaker.state, 'half-open');

  const closed = run(lab, DEFAULT_CONFIG.halfOpenProbes * DEFAULT_CONFIG.healthyLatencyTicks + 2);
  assert.equal(closed.breaker.state, 'closed');
  assert.equal(closed.breaker.consecutiveFailures, 0);
});

test('open breaker sheds arrivals to fallback instead of parking them', () => {
  const lab = createLab({ protection: 'breaker' });
  setDependencyMode(lab, 'dead');
  while (lab.breaker.state !== 'open') tick(lab);
  run(lab, 10);
  const m = metrics(lab);
  assert.ok(m.fallbacks > 0);
  assert.equal(m.waiting, 0, 'no backlog while the breaker is open');
});

test('immediate retries multiply the pile-up — the retry storm', () => {
  const none = createLab({ protection: 'none' });
  setDependencyMode(none, 'dead');
  run(none, 50);

  const storm = createLab({ protection: 'none', retryPolicy: 'immediate' });
  setDependencyMode(storm, 'dead');
  run(storm, 50);

  // Same dead dependency, same slot-bound timeouts — but every request fires
  // up to 4 calls, so the backlog balloons several-fold.
  assert.ok(metrics(storm).inFlight > metrics(none).inFlight * 3,
    `storm ${metrics(storm).inFlight} in flight vs plain ${metrics(none).inFlight}`);
});

test('immediate retries cost nothing while the dependency is healthy', () => {
  const lab = run(createLab({ protection: 'none', retryPolicy: 'immediate' }), 30);
  const m = metrics(lab);
  assert.equal(m.timedOut, 0);
  assert.ok(m.inFlight <= 6, `healthy baseline stays light, got ${m.inFlight}`);
});

test('metrics exposes the documented shape', () => {
  const m = metrics(run(createLab(), 5));
  for (const key of ['tick', 'inFlight', 'poolUsed', 'completed', 'timedOut', 'fallbacks',
    'avgLatencyTicks', 'errorRate', 'breakerState', 'consecutiveFailures', 'openUntilTick']) {
    assert.ok(key in m, `metrics() missing ${key}`);
  }
});
