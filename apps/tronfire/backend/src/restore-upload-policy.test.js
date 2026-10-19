import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { validateBackupFilename, releasePreparedRestore, claimPreparedRestore, restorePreparationMessage } from './restore-upload-policy.js';

function database() {
  const row = { id: 'db1', operationToken: 'token1', operationStatus: 'RUNNING', operationKind: 'RESTORE', operationMessage: restorePreparationMessage };
  const matches = where => Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = { managedDatabase: {
    async findFirst({ where }) { return matches(where) ? { ...row } : null; },
    async updateMany({ where, data }) {
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }
  } };
  return { row, prisma };
}

test('supports complete backup extensions only, including mixed case and gzip', () => {
  for (const file of ['backup.gbk', 'BACKUP.FBK', 'backup.GBK.GZ', 'backup.fbk.gz']) validateBackupFilename(file);
  for (const file of ['backup.001', 'backup.gbk.001', 'backup.gz', '', null, 'backup.fdb']) {
    assert.throws(() => validateBackupFilename(file), error => error.statusCode === 400);
  }
});

test('release is token-specific and idempotent', async () => {
  const { row, prisma } = database();
  assert.equal(await releasePreparedRestore(prisma, 'other'), null);
  assert.equal(await releasePreparedRestore(prisma, null), null);
  assert.equal(row.operationStatus, 'RUNNING');
  assert.equal((await releasePreparedRestore(prisma, 'token1')).id, 'db1');
  assert.equal(row.operationStatus, 'IDLE');
  assert.equal(await releasePreparedRestore(prisma, 'token1'), null);
});

test('an active restore cannot be released or claimed again', async () => {
  const { row, prisma } = database();
  assert.equal(await claimPreparedRestore(prisma, row, { operationMessage: 'Restore/migracao manual em andamento' }), true);
  assert.equal(await releasePreparedRestore(prisma, 'token1'), null);
  assert.equal(await claimPreparedRestore(prisma, row, { operationMessage: 'other' }), false);
  assert.equal(row.operationStatus, 'RUNNING');
});

test('release cannot clear a restore that starts between its read and write', async () => {
  const { row, prisma } = database();
  const find = prisma.managedDatabase.findFirst;
  prisma.managedDatabase.findFirst = async args => {
    const result = await find(args);
    row.operationMessage = 'Restore/migracao manual em andamento';
    return result;
  };
  assert.equal(await releasePreparedRestore(prisma, 'token1'), null);
  assert.equal(row.operationStatus, 'RUNNING');
});

test('a released preparation cannot later start a restore with its old token', async () => {
  const { row, prisma } = database();
  const before = { ...row };
  await releasePreparedRestore(prisma, 'token1');
  assert.equal(await claimPreparedRestore(prisma, before, { operationMessage: 'active' }), false);
  assert.equal(row.operationStatus, 'IDLE');
});

function routes(overrides = {}) {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/uploads/gbk'");
  const end = source.indexOf("app.post('/api/restores/from-upload'", start);
  const handlers = {};
  const { row, prisma } = database();
  let removed = 0;
  const context = {
    app: { post(path, options, handler) { handlers[path] = handler; } },
    async requireOperator() {}, prisma, crypto, pipeline,
    validateBackupFilename, releasePreparedRestore, restorePreparationMessage,
    audit: async () => {}, assertPrimaryWritable() {}, makeToken: () => 'new-token',
    fs: { createWriteStream: () => new Writable({ write(chunk, encoding, done) { done(); } }),
      promises: { async unlink() { removed += 1; } } },
    ...overrides
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { handlers, row, prisma, removed: () => removed };
}

test('prepare rejects .001 before touching a database or acquiring a lock', async () => {
  const { handlers, row } = routes();
  await assert.rejects(handlers['/api/restores/prepare']({ body: { filename: 'backup.001', databaseId: 'db1' } }, {}), /Envie apenas/);
  assert.equal(row.operationToken, 'token1');
});

test('invalid, missing, interrupted and oversized uploads release only their preparation', async () => {
  const cases = [
    () => ({ filename: 'backup.001', file: Readable.from(['invalid']) }),
    () => null,
    () => ({ filename: 'backup.gbk', file: Readable.from((async function* () { yield 'part'; throw new Error('network interrupted'); })()) }),
    () => { const file = Readable.from(['too large']); file.truncated = true; return { filename: 'backup.gbk', file }; }
  ];
  for (const readFile of cases) {
    const { handlers, row } = routes();
    await assert.rejects(handlers['/api/uploads/gbk']({ headers: { 'x-restore-operation-token': 'token1' }, file: async () => readFile() }));
    assert.equal(row.operationStatus, 'IDLE');
  }
});

test('successful upload preserves the preparation and returns a checksum', async () => {
  const { handlers, row, removed } = routes();
  const result = await handlers['/api/uploads/gbk']({ headers: { 'x-restore-operation-token': 'token1' }, file: async () => ({ filename: 'backup.GBK', file: Readable.from(['backup']) }) });
  assert.equal(result.ok, true);
  assert.equal(result.sha256, crypto.createHash('sha256').update('backup').digest('hex'));
  assert.equal(row.operationStatus, 'RUNNING');
  assert.equal(removed(), 0);
});

test('failed upload removes partial output without releasing an active restore', async () => {
  const { handlers, row, removed } = routes();
  row.operationMessage = 'Restore/migracao manual em andamento';
  const file = Readable.from(['partial']); file.truncated = true;
  await assert.rejects(handlers['/api/uploads/gbk']({ headers: { 'x-restore-operation-token': 'token1' }, file: async () => ({ filename: 'backup.gbk', file }) }));
  assert.equal(removed(), 1);
  assert.equal(row.operationStatus, 'RUNNING');
});

function frontend(filename, uploadError) {
  const source = fs.readFileSync(new URL('../../frontend/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('  btnGbk.onclick = async () => {');
  const end = source.indexOf('  btnServerRestore.onclick', start);
  const calls = [];
  const context = {
    btnGbk: {}, gbkFile: { files: [{ name: filename }] }, gbkOut: {}, btnCancelUpload: { classList: { add() {}, remove() {} } },
    restoreDb: { value: 'db1', selectedIndex: 0, options: [{ text: 'test', dataset: { alias: 'test' } }] },
    uploadProgressWrap: { classList: { remove() {} } }, uploadProgress: { style: {} },
    appDialog: async () => { calls.push('confirm'); return true; },
    api: async (path, options) => { calls.push(path); return { operation: { operationToken: 'token1' } }; },
    releaseRestorePrepare: async token => { if (token) calls.push('release:' + token); },
    FormData: class { append() {} },
    apiFormProgress(path, form, onProgress, token) {
      calls.push('upload:' + token);
      return { promise: Promise.reject(uploadError), abort() {} };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { context, calls };
}

test('frontend rejects .001 before confirmation, prepare or upload', async () => {
  const { context, calls } = frontend('backup.001');
  await context.btnGbk.onclick();
  assert.deepEqual(calls, []);
  assert.match(context.gbkOut.textContent, /Arquivo nao suportado/);
});

test('frontend releases preparation after upload rejection, cancellation or network error', async () => {
  for (const error of ['unsupported', 'Upload cancelado pelo usuario', 'Falha de rede durante o upload']) {
    const { context, calls } = frontend('backup.fbk.gz', new Error(error));
    await context.btnGbk.onclick();
    assert.ok(calls.includes('/api/restores/prepare'));
    assert.ok(calls.includes('upload:token1'));
    assert.ok(calls.includes('release:token1'));
    assert.equal(context.btnGbk.disabled, false);
  }
});

test('release route leaves a running restore protected', async () => {
  const { handlers, row } = routes();
  row.operationMessage = 'Restore/migracao manual em andamento';
  const result = await handlers['/api/restores/release']({ body: { operationToken: 'token1' } });
  assert.equal(result.released, false);
  assert.equal(row.operationStatus, 'RUNNING');
});

test('XHR rejects a non-JSON response instead of leaving the upload pending', async () => {
  const source = fs.readFileSync(new URL('../../frontend/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function apiFormProgress(');
  const end = source.indexOf('\nconst loginPage', start);
  let xhr;
  class Request {
    constructor() { xhr = this; this.upload = {}; this.headers = {}; }
    open() {}
    setRequestHeader(key, value) { this.headers[key] = value; }
    send() {}
  }
  const context = { XMLHttpRequest: Request, apiUrl: path => path };
  vm.runInNewContext(source.slice(start, end), context);
  const request = context.apiFormProgress('/api/uploads/gbk', {}, null, 'token1');
  assert.equal(xhr.headers['x-restore-operation-token'], 'token1');
  xhr.responseText = '<html>proxy error</html>';
  xhr.status = 502;
  xhr.onload();
  await assert.rejects(request.promise, /Resposta invalida/);
});

test('real multipart HTTP rejects .001 and frees its reservation while accepting GBK', { timeout: 5000 }, async t => {
  const require = createRequire(import.meta.url);
  let Fastify, multipart;
  try { Fastify = require('fastify'); multipart = require('@fastify/multipart'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip('Requires backend dependencies; run inside the backend image');
    return;
  }
  const app = Fastify();
  t.after(() => app.close());
  await app.register(multipart);
  const { row } = routes({ app });
  const upload = filename => app.inject({
    method: 'POST', url: '/api/uploads/gbk',
    headers: { 'content-type': 'multipart/form-data; boundary=backup-test', 'x-restore-operation-token': 'token1' },
    payload: Buffer.from(`--backup-test\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nbackup\r\n--backup-test--\r\n`)
  });
  const rejectedPrepare = await app.inject({ method: 'POST', url: '/api/restores/prepare', payload: { filename: 'backup.001', databaseId: 'db1' } });
  assert.equal(rejectedPrepare.statusCode, 400);
  const rejected = await upload('backup.001');
  assert.equal(rejected.statusCode, 400);
  assert.equal(row.operationStatus, 'IDLE');
  Object.assign(row, { operationStatus: 'RUNNING', operationKind: 'RESTORE', operationToken: 'token1', operationMessage: restorePreparationMessage });
  const accepted = await upload('backup.gbk');
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().ok, true);
  assert.equal(row.operationStatus, 'RUNNING');
});
