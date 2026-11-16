import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { isBiPath, proxyBi } from './bi-proxy.mjs';

test('BI routing does not capture other applications or similar prefixes', () => {
  for (const path of ['/bi', '/bi/', '/bi/login', '/bi/_next/static/main.js', '/bi/api/auth/login']) assert.equal(isBiPath(path), true);
  for (const path of ['/', '/tronsoft/', '/tronfire/', '/api/test', '/api/auth/login', '/api/printers', '/api/auth/user/token/', '/qr/', '/mesa/', '/bi-other', '/billing', '/kds/', '/gerente/', '/retaguarda/']) {
    assert.equal(isBiPath(path), false);
  }
});

test('BI proxy preserves prefix, query, methods, assets and redirects', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/bi') { res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/bi/` }); return res.end(); }
    res.setHeader('content-type', 'text/plain');
    res.end(`${req.method} ${req.url}`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const gateway = http.createServer((req, res) => proxyBi(req, res, upstream.address().port));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    for (const path of ['/bi/', '/bi/assets/main.js?v=1']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `GET ${path}`);
    }
    const response = await fetch(base + '/bi', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/bi/');
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
  }
});
