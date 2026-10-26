import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { isKdsPath, proxyKds } from './kds-proxy.mjs';

test('KDS routing does not capture other applications or similar prefixes', () => {
  for (const path of ['/kds', '/kds/', '/kds/assets/main.js', '/api/kds/stations/', '/api/auth/user/token/', '/api/print/agents/']) assert.equal(isKdsPath(path), true);
  for (const path of ['/', '/tronsoft/', '/tronfire/', '/api/test', '/api/auth/login', '/api/printers', '/api/auth/username', '/qr/', '/mesa/', '/kds-other', '/kdss']) {
    assert.equal(isKdsPath(path), false);
  }
});

test('KDS proxy preserves prefix, query, methods, assets and redirects', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/kds') { res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/kds/` }); return res.end(); }
    res.setHeader('content-type', 'text/plain');
    res.end(`${req.method} ${req.url}`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const gateway = http.createServer((req, res) => proxyKds(req, res, upstream.address().port));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    for (const path of ['/kds/', '/kds/assets/main.js?v=1']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `GET ${path}`);
    }
    const response = await fetch(base + '/kds', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/kds/');
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
  }
});
