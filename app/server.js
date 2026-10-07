import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from '../public/patterns.mjs';
import { SCENARIOS, createLab, runScenario, PROTECTION_MODES, RETRY_POLICIES } from '../public/lab.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATIC_FILES = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/guide.html', ['text/html; charset=utf-8', 'guide.html']],
  ['/styles.css', ['text/css; charset=utf-8', 'styles.css']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/lab.mjs', ['text/javascript; charset=utf-8', 'lab.mjs']],
  ['/patterns.mjs', ['text/javascript; charset=utf-8', 'patterns.mjs']],
  ['/pb-shell.css', ['text/css; charset=utf-8', 'pb-shell.css']],
  ['/pb-back.css', ['text/css; charset=utf-8', 'pb-back.css']],
].map(([path, [type, file]]) => [path, [type, readFileSync(join(PUBLIC, file))]]));
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const json = (res, status, body) =>
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));

// Server-side replay of a scenario — same modules the browser runs, so the
// API returns the identical incident the Lab tab draws.
function scenarioSummary(url) {
  const name = url.searchParams.get('name') || 'killRecover';
  const steps = SCENARIOS[name];
  if (!steps) return [404, { error: `unknown scenario ${name}`, known: Object.keys(SCENARIOS) }];
  const protection = url.searchParams.get('protection') || 'none';
  const retryPolicy = url.searchParams.get('retry') || 'none';
  if (!PROTECTION_MODES.includes(protection) || !RETRY_POLICIES.includes(retryPolicy)) {
    return [400, { error: 'bad protection or retry', protection: PROTECTION_MODES, retry: RETRY_POLICIES }];
  }
  const lab = createLab({ protection, retryPolicy });
  const snapshots = runScenario(lab, steps);
  const last = snapshots[snapshots.length - 1];
  return [200, {
    scenario: name,
    protection,
    retryPolicy,
    ticks: snapshots.length,
    cascadeTicks: snapshots.filter(s => s.cascading).length,
    maxSaturation: Math.max(...snapshots.map(s => s.poolSaturation)),
    maxInFlight: Math.max(...snapshots.map(s => s.inFlight)),
    timedOut: last.timedOut,
    completed: last.completed,
    fallbacks: last.fallbacks,
    breakerState: last.breakerState,
    breakerTrips: lab.events.filter(e => e.kind === 'open').length,
    events: lab.events,
  }];
}

export function createStaticServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (url.pathname === '/version') {
      json(res, 200, {
        name: PACKAGE.name,
        version: PACKAGE.version,
        commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
      });
      return;
    }
    if (url.pathname === '/api/patterns') {
      json(res, 200, PATTERNS);
      return;
    }
    if (url.pathname === '/api/scenario') {
      const [status, body] = scenarioSummary(url);
      json(res, status, body);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC_FILES.get(url.pathname);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise(resolve => server.close(resolve));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  console.log(`Trip Line listening on ${server.address().port}`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
