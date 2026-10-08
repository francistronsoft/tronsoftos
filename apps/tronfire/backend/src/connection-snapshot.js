export function connectionSnapshotMaxAgeMs(value) {
  const parsed = Number(value);
  const minutes = Number.isFinite(parsed) ? Math.max(1, Math.min(60, Math.round(parsed))) : 5;
  return minutes * 60000 + 30000;
}

export function connectionSummaryFromSnapshot(database, snapshot, options = {}) {
  if (!database || !snapshot?.collectedAt) return null;
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 150_000;
  const collectedAtMs = new Date(snapshot.collectedAt).getTime();
  if (!Number.isFinite(collectedAtMs) || nowMs - collectedAtMs > maxAgeMs) return null;
  return {
    databaseId: database.id,
    databaseName: database.name,
    databaseAlias: database.alias,
    total: Number(snapshot.totalConnections || 0),
    collectedAt: new Date(snapshot.collectedAt).toISOString(),
    source: 'worker-snapshot'
  };
}
