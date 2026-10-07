import {
  createLab, setDependencyMode, setProtection, setRetryPolicy,
  tick, metrics, isCascading, SCENARIOS, DEFAULT_CONFIG,
} from '/lab.mjs';

const $ = sel => document.querySelector(sel);
const TICK_MS_UI = 140;
const TRACE_LEN = 140;
const WIRE = { x0: 210, x1: 750, y: 140 };

let lab = createLab();
let running = false;
let timer = null;
let replay = null; // {steps, cursor, remaining}
let loggedEvents = 0;
const history = { sat: [], lat: [], tos: [] };

const diagram = $('#diagram');
const eventLog = $('#event-log');
const statusBadge = $('#status-badge');
const pulses = $('#pulses');
const poolStrip = $('#pool-strip');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function readRadios() {
  return {
    dep: document.querySelector('input[name="dep"]:checked').value,
    protection: document.querySelector('input[name="protection"]:checked').value,
    retry: document.querySelector('input[name="retry"]:checked').value,
  };
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function resetLab() {
  const { dep, protection, retry } = readRadios();
  lab = createLab({ dependencyMode: dep, protection, retryPolicy: retry });
  loggedEvents = 0;
  prevTimedOut = 0;
  history.sat.length = history.lat.length = history.tos.length = 0;
  eventLog.innerHTML = '';
  render();
}

// ---- replay: the scripted kill → heal incident ----------------------------

function startReplay() {
  const { protection, retry } = readRadios();
  setRadio('dep', 'healthy');
  lab = createLab({ protection, retryPolicy: retry });
  loggedEvents = 0;
  prevTimedOut = 0;
  history.sat.length = history.lat.length = history.tos.length = 0;
  eventLog.innerHTML = '';
  replay = { steps: SCENARIOS.killRecover, cursor: 0, remaining: 0 };
  setRunning(true);
}

function replayStep() {
  if (!replay) return;
  if (replay.remaining === 0) {
    const step = replay.steps[replay.cursor++];
    if (!step) { replay = null; setRunning(false); return; }
    if (step.dependencyMode) {
      setDependencyMode(lab, step.dependencyMode);
      setRadio('dep', step.dependencyMode);
    }
    replay.remaining = step.ticks;
  }
  replay.remaining -= 1;
}

// ---- controls ---------------------------------------------------------------

function setRunning(on) {
  running = on;
  $('#btn-run').textContent = running ? 'Pause' : 'Run';
  if (running && !timer) timer = setInterval(stepOnce, TICK_MS_UI);
  if (!running && timer) { clearInterval(timer); timer = null; }
}

function stepOnce() {
  replayStep();
  tick(lab);
  render();
}

$('#btn-run').addEventListener('click', () => setRunning(!running));
$('#btn-step').addEventListener('click', () => { replayStep(); tick(lab); render(); });
$('#btn-replay').addEventListener('click', startReplay);
$('#btn-reset').addEventListener('click', () => { replay = null; setRunning(false); resetLab(); });

for (const input of document.querySelectorAll('input[name="dep"]')) {
  input.addEventListener('change', () => setDependencyMode(lab, input.value));
}
for (const input of document.querySelectorAll('input[name="protection"]')) {
  input.addEventListener('change', () => setProtection(lab, input.value));
}
for (const input of document.querySelectorAll('input[name="retry"]')) {
  input.addEventListener('change', () => setRetryPolicy(lab, input.value));
}

// ---- render -----------------------------------------------------------------

const fmt = n => n.toLocaleString('en-US');

function pulseClass(call) {
  if (call.probe) return 'pulse probe';
  if (call.latency === Infinity) return 'pulse doomed';
  if (call.latency === DEFAULT_CONFIG.slowLatencyTicks) return 'pulse slow';
  return 'pulse ok';
}

function renderPulses() {
  pulses.innerHTML = '';
  const dots = lab.active.slice(0, 18);
  for (const call of dots) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const bound = call.latency === Infinity ? lab.config.callTimeoutTicks : call.latency;
    const frac = Math.min(call.age / bound, 1);
    c.setAttribute('cx', WIRE.x0 + frac * (WIRE.x1 - WIRE.x0));
    c.setAttribute('cy', WIRE.y);
    c.setAttribute('r', 4.5);
    c.setAttribute('class', pulseClass(call));
    pulses.appendChild(c);
  }
}

function renderPool() {
  poolStrip.innerHTML = '';
  const total = lab.config.poolSize;
  for (let i = 0; i < total; i++) {
    const slot = document.createElement('span');
    const call = lab.active[i];
    slot.className = 'pool-slot' + (call ? (call.latency === Infinity ? ' doomed' : call.probe ? ' probe' : ' busy') : '');
    poolStrip.appendChild(slot);
  }
}

let prevTimedOut = 0;

function renderTrace(m) {
  history.sat.push(m.poolSaturation * 100);
  history.lat.push(Math.min(m.avgLatencyTicks / lab.config.callTimeoutTicks, 1) * 100);
  history.tos.push(m.timedOut > prevTimedOut ? 1 : 0); // timeout tick markers
  prevTimedOut = m.timedOut;
  if (history.sat.length > TRACE_LEN) { history.sat.shift(); history.lat.shift(); history.tos.shift(); }
  const toX = i => (i / (TRACE_LEN - 1)) * 640;
  const toY = v => 140 - (v / 100) * 128;
  $('#trace-pool').setAttribute('points', history.sat.map((v, i) => `${toX(i)},${toY(v)}`).join(' '));
  $('#trace-lat').setAttribute('points', history.lat.map((v, i) => `${toX(i)},${toY(v)}`).join(' '));
  const marks = $('#trace-timeouts');
  marks.innerHTML = '';
  for (let i = 0; i < history.tos.length; i++) {
    if (!history.tos[i]) continue;
    const x = toX(i);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x); line.setAttribute('y1', 130);
    line.setAttribute('x2', x); line.setAttribute('y2', 150);
    line.setAttribute('class', 'to-mark');
    marks.appendChild(line);
  }
}

function renderEvents() {
  loggedEvents = Math.min(loggedEvents, lab.events.length); // ring-buffer trims
  const fresh = lab.events.slice(loggedEvents);
  loggedEvents = lab.events.length;
  for (const e of fresh) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="e-tick">t${String(e.tick).padStart(4, '0')}</span> <strong>${e.kind}</strong> — ${e.detail}`;
    eventLog.prepend(li);
  }
  while (eventLog.children.length > 40) eventLog.lastChild.remove();
}

function renderStatus(m) {
  let text = 'steady', cls = 'badge pass';
  if (isCascading(lab)) { text = 'CASCADE'; cls = 'badge danger'; }
  else if (m.breakerState === 'open') { text = 'tripped — failing fast'; cls = 'badge warn'; }
  else if (m.breakerState === 'half-open') { text = 'half-open — probing'; cls = 'badge warn'; }
  else if (m.dependencyMode === 'dead') { text = 'dependency dead'; cls = 'badge warn'; }
  else if (m.dependencyMode === 'slow') { text = 'degraded'; cls = 'badge warn'; }
  if (statusBadge.textContent !== text) statusBadge.textContent = text;
  statusBadge.className = cls;
}

function render() {
  const m = metrics(lab);
  $('#m-tick').textContent = fmt(m.tick);
  $('#m-pool').textContent = `${m.poolUsed}/${lab.config.poolSize}`;
  $('#m-queue').textContent = fmt(m.waiting);
  $('#m-breaker').textContent = m.breakerState;
  $('#m-lat').textContent = `${m.avgLatencyTicks.toFixed(1)}t`;
  $('#m-timeouts').textContent = fmt(m.timedOut);
  $('#m-fallbacks').textContent = fmt(m.fallbacks);
  $('#m-err').textContent = `${Math.round(m.errorRate * 100)}%`;
  $('#pool-pct').textContent = `${Math.round(m.poolSaturation * 100)}%`;

  diagram.dataset.breaker = m.breakerState;
  diagram.dataset.dep = m.dependencyMode;
  diagram.dataset.cascading = isCascading(lab);
  $('#dep-sub').textContent =
    m.dependencyMode === 'dead' ? 'dead — no answer' :
    m.dependencyMode === 'slow' ? `slow · ${lab.config.slowLatencyTicks} ticks` :
    `healthy · ${lab.config.healthyLatencyTicks} ticks`;
  $('#breaker-label').textContent =
    m.breakerState === 'open' ? `OPEN — fallback for ${Math.max(0, m.openUntilTick - m.tick)}t` :
    m.breakerState === 'half-open' ? 'half-open — probing' : 'circuit breaker';

  renderPulses();
  renderPool();
  renderTrace(m);
  renderEvents();
  renderStatus(m);
}

resetLab();
render();
