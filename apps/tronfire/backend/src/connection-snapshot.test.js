import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionSummaryFromSnapshot } from './connection-snapshot.js';

const database = { id: 'db-1', name: 'FARROUPILHA', alias: 'erp_tronsoft' };

test('uses a recent worker connection snapshot', () => {
  const summary = connectionSummaryFromSnapshot(
    database,
    { totalConnections: 7, collectedAt: '2026-09-21T12:00:00.000Z' },
    { nowMs: Date.parse('2026-09-21T12:01:00.000Z'), maxAgeMs: 120_000 }
  );

  assert.equal(summary.total, 7);
  assert.equal(summary.source, 'worker-snapshot');
  assert.equal(summary.databaseAlias, 'erp_tronsoft');
});

test('rejects a stale worker connection snapshot', () => {
  const summary = connectionSummaryFromSnapshot(
    database,
    { totalConnections: 7, collectedAt: '2026-09-21T12:00:00.000Z' },
    { nowMs: Date.parse('2026-09-21T12:03:00.000Z'), maxAgeMs: 120_000 }
  );

  assert.equal(summary, null);
});
