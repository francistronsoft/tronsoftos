export const restorePreparationMessage = 'Restore/migracao manual aguardando upload/execucao';

export function validateBackupFilename(filename) {
  if (!/\.(gbk|fbk)(\.gz)?$/i.test(String(filename || ''))) {
    const error = new Error('Envie apenas .GBK, .FBK, .GBK.GZ ou .FBK.GZ. Arquivos .001 nao sao aceitos; use um backup completo em formato suportado.');
    error.statusCode = 400;
    throw error;
  }
}

function preparationWhere(token) {
  return {
    operationToken: token,
    operationStatus: 'RUNNING',
    operationKind: 'RESTORE',
    operationMessage: restorePreparationMessage
  };
}

export async function releasePreparedRestore(prisma, token) {
  if (!token || typeof token !== 'string') return null;
  const where = preparationWhere(token);
  const db = await prisma.managedDatabase.findFirst({ where });
  if (!db) return null;
  const result = await prisma.managedDatabase.updateMany({
    where: { id: db.id, ...where },
    data: {
      operationStatus: 'IDLE', operationKind: null, operationToken: null,
      operationStartedAt: null, operationExpiresAt: null, operationMessage: null
    }
  });
  return result.count === 1 ? db : null;
}

export async function claimPreparedRestore(prisma, db, data) {
  const result = await prisma.managedDatabase.updateMany({
    where: { id: db.id, ...preparationWhere(db.operationToken) }, data
  });
  return result.count === 1;
}
