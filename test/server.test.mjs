import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../app/server.js';
import { once } from 'node:events';

async function withServer(fn) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('/health and /version respond; static allowlist serves the lab', async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).name, '12-system-design-patterns-every-engineer-should-demo');

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Trip Line/);
    assert.match(html, /<nav aria-label="Primary">/);
    assert.match(html, /href="\/guide\.html"/);

    const guide = await fetch(`${base}/guide.html`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /aria-current="page" href="\/guide\.html"/);

    for (const path of ['/app.js', '/lab.mjs', '/patterns.mjs', '/styles.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });
});

test('/api/patterns returns the 12-entry catalog', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/api/patterns`);
    assert.equal(res.status, 200);
    const patterns = await res.json();
    assert.equal(patterns.length, 12);
    assert.equal(patterns[2].id, 'circuit-breaker');
  });
});

test('/api/scenario replays the incident — breaker contains, none cascades', async () => {
  await withServer(async base => {
    const open = await fetch(`${base}/api/scenario?protection=none`);
    assert.equal(open.status, 200);
    const cascade = await open.json();
    assert.ok(cascade.cascadeTicks > 0, 'unprotected kill should cascade');
    assert.ok(cascade.timedOut > 0);

    const tripped = await fetch(`${base}/api/scenario?protection=breaker`);
    const contained = await tripped.json();
    assert.equal(contained.cascadeTicks, 0);
    assert.ok(contained.fallbacks > 0);
    assert.ok(contained.breakerTrips >= 1);
    assert.equal(contained.breakerState, 'closed');

    const bad = await fetch(`${base}/api/scenario?name=bogus`);
    assert.equal(bad.status, 404);
  });
});

test('unknown paths and traversal return 404; HEAD works', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/app/server.js`)).status, 404);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});
