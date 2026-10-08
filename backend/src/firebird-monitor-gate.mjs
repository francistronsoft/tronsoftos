import { createHash } from 'node:crypto';

export function firebirdScriptClass(value = 'manual') {
  if (!['monitor', 'backup', 'validation', 'sweep', 'manual'].includes(value)) {
    throw new Error('Classe de script Firebird invalida');
  }
  return value;
}

export function createFirebirdMonitorGate({ cacheMs = 5000, slowMs = 10000, emit = () => {}, now = Date.now } = {}) {
  const cache = new Map();
  let active = null;
  let slowFailures = 0;
  return async function monitorGate({ script, origin = 'unknown', operationClass = 'manual' }, execute) {
    firebirdScriptClass(operationClass);
    if (operationClass !== 'monitor') return execute();
    const key = createHash('sha256').update(script).digest('hex');
    for (const [cachedKey, value] of cache) {
      if (now() - value.at >= cacheMs) cache.delete(cachedKey);
    }
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheMs) {
      emit('FIREBIRD_MONITOR_REUSED', { origin, operationClass, cached: true, durationMs: 0 });
      return { ...cached.result, cached: true };
    }
    if (active) {
      if (active.key === key) {
        const waitingAt = now();
        const result = await active.promise;
        emit('FIREBIRD_MONITOR_REUSED', { origin, operationClass, shared: true, waitMs: now() - waitingAt });
        return { ...result, shared: true };
      }
      emit('FIREBIRD_MONITOR_DEFERRED', { origin, operationClass, waitMs: 0 });
      return { ok: false, deferred: true, retryAfterMs: 5000, error: 'Monitoramento Firebird ja em andamento' };
    }
    const startedAt = now();
    const entry = { key, promise: null };
    active = entry;
    entry.promise = Promise.resolve().then(execute).then(result => {
      const durationMs = now() - startedAt;
      const timedOut = [124, 137].includes(Number(result.exitCode)) || result.signal === 'SIGTERM';
      if (!result.deferred) {
        slowFailures = durationMs >= slowMs || timedOut ? slowFailures + 1 : 0;
        emit('FIREBIRD_MONITOR_COMPLETED', { origin, operationClass, durationMs, timedOut, ok: result.ok !== false, slowFailures });
        if (slowFailures === 2) emit('FIREBIRD_MONITOR_SLOW', { origin, operationClass, durationMs, timedOut, slowFailures });
      }
      if (result.ok !== false && !result.deferred && Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024) {
        cache.delete(key);
        cache.set(key, { result, at: now() });
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      }
      return { ...result, monitorSlowFailures: slowFailures, monitorDurationMs: durationMs };
    }).finally(() => {
      if (active === entry) active = null;
    });
    return entry.promise;
  };
}
