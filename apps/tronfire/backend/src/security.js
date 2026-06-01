import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma.js';

const SESSION_DURATION_MS = Math.max(Number(process.env.SESSION_DURATION_HOURS || 24), 1) * 60 * 60 * 1000;
const AUTH_DISABLED = String(process.env.TRONFIRE_AUTH_DISABLED ?? 'true').toLowerCase() !== 'false';
const SYSTEM_USER = {
  id: null,
  name: 'TronSoftOS',
  email: 'tronsoftos@local',
  role: 'ADMIN',
  active: true
};

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function makeToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export async function createSession(user, req) {
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  const token = makeToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await prisma.session.create({ data: { userId: user.id, tokenHash, expiresAt, ipAddress: req.ip, userAgent: req.headers['user-agent'] || '' } });
  return token;
}

export async function requireAuth(req, reply) {
  if (AUTH_DISABLED) {
    req.user = SYSTEM_USER;
    req.session = null;
    return;
  }
  const token = req.cookies.tronfire_session;
  if (!token) return reply.code(401).send({ error: 'UNAUTHORIZED' });
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.active) {
    return reply.code(401).send({ error: 'UNAUTHORIZED' });
  }
  await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_DURATION_MS) } });
  req.user = session.user;
  req.session = session;
}

export async function requireAdmin(req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
}

export async function requireRole(roles, req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'FORBIDDEN' });
}

export async function requireOperator(req, reply) {
  return requireRole(['ADMIN', 'TECNICO'], req, reply);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
