import http from 'node:http';
import { isIP } from 'node:net';

function isLocalAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (address === 'localhost' || address === '::1') return true;
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function biCookieForRequest(cookie, req) {
  // The BI image always emits Secure. Permit its session over explicit LAN HTTP
  // while keeping HTTPS, public origins and unrelated cookies untouched.
  let host;
  try { host = new URL(`http://${req.headers.host || ''}`).hostname; } catch { return cookie; }
  const forwarded = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
  if (req.socket?.encrypted || (forwarded && forwarded !== 'http') ||
      !isLocalAddress(host) || !isLocalAddress(req.socket?.remoteAddress)) return cookie;
  if (!/^token=/i.test(cookie) || !/;\s*Path=\/bi(?:;|$)/i.test(cookie)) return cookie;
  return cookie.replace(/;\s*Secure(?=;|$)/ig, '');
}

export function isBiPath(pathname) {
  return ['/bi'].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function proxyBi(req, reply, port = 8013) {
  const blocked = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !blocked.has(key.toLowerCase())));
  const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers }, response => {
    const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !blocked.has(key.toLowerCase())));
    if (Array.isArray(responseHeaders['set-cookie'])) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => biCookieForRequest(cookie, req));
    }
    if (typeof responseHeaders.location === 'string') {
      try {
        const location = new URL(responseHeaders.location);
        if (location.hostname === '127.0.0.1' && Number(location.port) === Number(port) && isBiPath(location.pathname)) {
          responseHeaders.location = `${location.pathname}${location.search}${location.hash}`;
        }
      } catch { /* Relative redirects already preserve the public origin. */ }
    }
    reply.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(reply);
    response.on('error', () => reply.destroy());
  });
  upstream.setTimeout(30000, () => upstream.destroy(new Error('Tron BI timeout')));
  upstream.on('error', () => {
    if (reply.destroyed) return;
    if (reply.headersSent) return reply.destroy();
    reply.writeHead(502, { 'content-type': 'application/json' });
    reply.end(JSON.stringify({ error: 'Tron BI indisponivel' }));
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}
