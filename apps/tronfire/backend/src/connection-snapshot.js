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
