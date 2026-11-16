'use strict';
const fs = require('node:fs');
const { createRequire } = require('node:module');

// Seed only an empty user table. Existing accounts and all other tables survive.
function bootstrapBi({ Database, dbPath, seedPath, enabled = true }) {
  if (!enabled) return 'disabled';
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS USUARIO (ID_USUARIO TEXT PRIMARY KEY, MD5_SENHA TEXT NOT NULL)');
    if (db.prepare('SELECT COUNT(*) AS n FROM USUARIO').get().n > 0) {
      db.exec('COMMIT');
      return 'preserved';
    }
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8').replace(/^\uFEFF/, ''));
    if (seed.username !== 'tronsoft' || !/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(seed.passwordHash)) {
      throw new Error('Invalid BI bootstrap seed');
    }
    db.prepare('INSERT INTO USUARIO (ID_USUARIO, MD5_SENHA) VALUES (?, ?)').run(seed.username, seed.passwordHash);
    db.exec('COMMIT');
    return 'created';
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
module.exports = { bootstrapBi };
if (require.main === module) {
  try {
    const enabled = process.env.BI_BOOTSTRAP_ENABLED !== 'false';
    const Database = enabled ? createRequire('/app/package.json')('better-sqlite3') : null;
    const status = bootstrapBi({ Database, enabled, dbPath: process.env.SQLITE_PATH || '/app/data/tron-bi.db', seedPath: '/run/tronsoftos/bi-bootstrap-user.json' });
    console.log(`BI bootstrap: ${status}`);
  } catch {
    console.error('BI bootstrap failed; check seed, SQLite permissions and available space');
    process.exitCode = 1;
  }
}
