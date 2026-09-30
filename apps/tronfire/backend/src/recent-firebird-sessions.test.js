import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('recent sessions prioritize active attachments before limiting history', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function recentFirebirdSessions('), source.indexOf('async function recentFirebirdConnectionSummary('));
  let query;
  const context = vm.createContext({
    prisma: { firebirdSession: { findMany: async options => { query = options; return [{ id: 758 }]; } } },
    serializeFirebirdSession: item => item
  });
  vm.runInContext(functionSource, context);
  assert.equal((await context.recentFirebirdSessions('erp'))[0].id, 758);
  assert.equal(query.where.databaseId, 'erp');
  assert.equal(query.where.OR[0].disconnectedAt, null);
  assert.equal(query.orderBy[0].disconnectedAt.nulls, 'first');
  assert.equal(query.orderBy[0].disconnectedAt.sort, 'asc');
  assert.equal(query.orderBy[1].lastSeenAt, 'desc');
  assert.equal(query.take, 50);
  query = null;
  assert.equal((await context.recentFirebirdSessions(null)).length, 0);
  assert.equal(query, null);
});
