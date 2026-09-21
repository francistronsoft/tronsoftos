import assert from 'node:assert/strict';
import test from 'node:test';
import { backupValidationFailurePolicy } from './validation-failure-policy.js';

test('a restore validation failure does not degrade the production database', () => {
  const policy = backupValidationFailurePolicy({
    reason: 'timeout de restore',
    windowKey: '2026-09-21'
  });

  assert.equal(policy.affectsProductionHealth, false);
  assert.equal(policy.reason, 'timeout de restore');
  assert.equal(policy.windowKey, '2026-09-21');
});

test('normalizes missing validation details', () => {
  assert.deepEqual(backupValidationFailurePolicy(), {
    affectsProductionHealth: false,
    reason: 'falha desconhecida',
    windowKey: null
  });
});
