import net from 'node:net';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://tronfire@postgres:5432/tronfire');
const host = databaseUrl.hostname || 'postgres';
const port = Number(databaseUrl.port || 5432);
const timeoutMs = Number(process.env.POSTGRES_WAIT_TIMEOUT_MS || 120_000);
const intervalMs = Number(process.env.POSTGRES_WAIT_INTERVAL_MS || 2_000);
const startedAt = Date.now();

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canConnect() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(3_000);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

while (Date.now() - startedAt < timeoutMs) {
  if (await canConnect()) {
    console.log(`[startup] PostgreSQL disponivel em ${host}:${port}`);
    process.exit(0);
  }
  console.log(`[startup] Aguardando PostgreSQL em ${host}:${port}...`);
  await wait(intervalMs);
}

console.error(`[startup] PostgreSQL indisponivel em ${host}:${port} apos ${timeoutMs}ms`);
process.exit(1);
