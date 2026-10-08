import net from 'node:net';

export function normalizeDns(value) {
  const entries = (Array.isArray(value) ? value.join(' ') : String(value || '')).trim().split(/[\s,]+/).filter(Boolean);
  if (entries.some(entry => !net.isIP(entry))) throw new Error('DNS invalido; informe enderecos IP validos');
  return [...new Set(entries.map(entry => entry.split('%')[0]))].join(' ');
}

export function sameDns(left, right) {
  return normalizeDns(left).split(' ').sort().join(' ') === normalizeDns(right).split(' ').sort().join(' ');
}
