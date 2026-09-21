export function backupValidationFailurePolicy({ reason, windowKey } = {}) {
  return {
    affectsProductionHealth: false,
    reason: String(reason || 'falha desconhecida'),
    windowKey: windowKey || null
  };
}
