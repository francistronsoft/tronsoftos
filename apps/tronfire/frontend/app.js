const tronsoftosProxyBase = window.location.pathname.startsWith('/tronfire') ? '/tronfire' : '';
const tronsoftosEmbedded = new URLSearchParams(window.location.search).get('embed') === '1';

function apiUrl(path) {
  const value = String(path || '');
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/api/')) return `${tronsoftosProxyBase}${value}`;
  return value;
}

if (tronsoftosEmbedded) {
  document.body.classList.add('tronsoftos-embedded');
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(apiUrl(path), { credentials: 'include', headers, ...options });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || 'Erro na API');
    err.status = res.status;
    err.code = payload.code;
    err.payload = payload;
    throw err;
  }
  return res.json();
}

async function apiForm(path, form) {
  const res = await fetch(apiUrl(path), { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) throw new Error((await res.json()).error || 'Erro no upload');
  return res.json();
}

function apiFormProgress(path, form, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', apiUrl(path));
    xhr.withCredentials = true;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100), event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      const payload = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else {
        const err = new Error(payload.error || 'Erro no upload');
        err.status = xhr.status;
        err.payload = payload;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Falha de rede durante o upload'));
    xhr.onabort = () => reject(new Error('Upload cancelado pelo usuario'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

const loginPage = document.getElementById('loginPage');
const appPage = document.getElementById('appPage');
const content = document.getElementById('content');
let currentUser = null;

function applyTheme(theme) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', mode);
  document.body.classList.toggle('theme-dark', mode === 'dark');
  localStorage.setItem('tronfire_theme', mode);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) btn.title = mode === 'dark' ? 'Usar tema claro' : 'Usar tema escuro';
}

applyTheme(localStorage.getItem('tronfire_theme') || 'light');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function showApp(user) {
  currentUser = user;
  loginPage.classList.add('hidden'); appPage.classList.remove('hidden');
  document.getElementById('userName').textContent = `${user.name} (${user.role})`;
  document.querySelectorAll('a[href="#databases"], a[href="#uploads"], a[href="#backups"], a[href="#logs"], a[href="#settings"]').forEach(link => {
    link.closest('li').classList.toggle('hidden', user.role === 'CONSULTA');
  });
  route();
}
function showLogin() { currentUser = null; appPage.classList.add('hidden'); loginPage.classList.remove('hidden'); }

function appDialog({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', variant = 'primary', showCancel = true }) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dialog-backdrop';
    backdrop.innerHTML = `<div class="app-dialog app-dialog-${escapeHtml(variant)}" role="dialog" aria-modal="true">
      <div class="card-header"><h3 class="card-title">${escapeHtml(title)}</h3></div>
      <div class="card-body">
        <div class="app-dialog-body">${escapeHtml(message)}</div>
      </div>
      <div class="card-footer d-flex justify-content-end gap-2">
        ${showCancel ? `<button class="btn btn-outline-secondary" data-dialog-cancel>${escapeHtml(cancelText)}</button>` : ''}
        <button class="btn btn-${variant}" data-dialog-confirm>${escapeHtml(confirmText)}</button>
      </div>
    </div>`;
    document.body.appendChild(backdrop);
    const close = value => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.querySelector('[data-dialog-confirm]').onclick = () => close(true);
    backdrop.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => close(false));
    backdrop.addEventListener('keydown', event => {
      if (event.key === 'Escape') close(false);
    });
    backdrop.tabIndex = -1;
    backdrop.focus();
  });
}

function appAlert(title, message, variant = 'primary') {
  return appDialog({ title, message, confirmText: 'OK', variant, showCancel: false });
}

document.getElementById('btnLogin').onclick = async () => {
  try {
    loginError.textContent = '';
    const credentials = { email: loginEmail.value, password: loginPassword.value };
    let out;
    try {
      out = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
    } catch (err) {
      if (err.code !== 'ACTIVE_SESSION') throw err;
      const ok = await appDialog({
        title: 'Sessao ativa encontrada',
        message: `${err.message}\n\nDeseja entrar mesmo assim e encerrar a sessao anterior?`,
        confirmText: 'Entrar e encerrar anterior',
        cancelText: 'Cancelar',
        variant: 'danger'
      });
      if (!ok) return;
      out = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ ...credentials, force: true }) });
    }
    showApp(out.user);
  } catch (err) { loginError.textContent = err.message; }
};

document.getElementById('btnLogout').onclick = async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.hash = '#dashboard';
    showLogin();
  }
};

document.getElementById('btnThemeToggle').onclick = () => {
  const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
  applyTheme(next);
};

function badge(type) {
  const map = { PRODUCAO: 'success', LEGADO_CONSULTA: 'secondary', HOMOLOGACAO: 'warning', TEMPLATE: 'info', ARQUIVADO: 'dark' };
  return `<span class="badge bg-${map[type] || 'secondary'}">${escapeHtml(type)}</span>`;
}

function operationBadge(db) {
  if (db.operationStatus !== 'RUNNING') return '<span class="badge bg-success">Livre</span>';
  const label = db.operationKind || 'Operacao';
  return `<span class="badge bg-warning text-dark" title="${escapeHtml(db.operationMessage || '')}">${escapeHtml(label)}</span>`;
}

function databaseStatusView(db, diagnostic) {
  if (diagnostic?.ok === false) return { text: 'Erro/offline', className: 'danger', title: diagnostic.error || 'Falha ao consultar o banco' };
  if (diagnostic?.ok) return { text: 'Conexao OK', className: 'success', title: 'Consulta via isql respondeu; use gfix -online se o ERP ficar limitado por shutdown/maintenance' };
  if (db.status === 'ONLINE') return { text: 'Conexao OK', className: 'success', title: 'Ultima validacao respondeu; use gfix -online se precisar forcar o modo online do Firebird' };
  if (db.status === 'ERROR') return { text: 'Erro/offline', className: 'danger', title: 'Ultima validacao encontrou erro' };
  return { text: db.status || 'UNKNOWN', className: 'secondary', title: 'Status ainda nao validado' };
}

function haOperationWarning(haStatus) {
  if (haStatus?.deploymentMode !== 'ha' || haStatus?.nodeRole !== 'primary') return '';
  return `<div class="alert alert-warning mb-3">
    Ambiente HA primary detectado. Restore, migracao e manutencao automatica colocam o banco em manutencao operacional e bloqueiam backup/sync/restore HA desse banco ate finalizar.
  </div>`;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBytes(value) {
  let bytes = num(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function operationToken() {
  return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17);
}

function logPathFor(prefix, alias, token) {
  const safeAlias = String(alias || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `/firebird/logs/${prefix}_${safeAlias}_${token}.log`;
}

function renderVerboseBox(target, title, logPath) {
  target.innerHTML = `<div class="mt-3">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <div class="d-flex align-items-center gap-2">
        <strong>${escapeHtml(title)}</strong>
        <span class="badge bg-primary" data-log-status>em andamento</span>
      </div>
      <code>${escapeHtml(logPath)}</code>
    </div>
    <pre class="log-preview mb-0">Aguardando inicio do log...</pre>
  </div>`;
  return target.querySelector('.log-preview');
}

function setVerboseStatus(output, text, variant = 'primary') {
  const status = output.closest('.mt-3')?.querySelector('[data-log-status]');
  if (!status) return;
  status.className = `badge bg-${variant}`;
  status.textContent = text;
}

function appendVerbose(output, text) {
  output.textContent = `${output.textContent}${text}`;
  output.scrollTop = output.scrollHeight;
}

async function finishVerbose(logPath, output, finalText, variant = 'success') {
  try {
    const data = await api(`/api/logs/tail?path=${encodeURIComponent(logPath)}`);
    if (data.exists) {
      output.textContent = data.content || 'Log finalizado sem conteudo.';
    }
  } catch (_) {
    // Mantem o ultimo conteudo do polling se o tail final nao responder.
  }
  appendVerbose(output, `\n\n${finalText}`);
  setVerboseStatus(output, variant === 'success' ? 'concluido' : 'falhou', variant);
}

function formatDateTime(value) {
  if (!value) return 'nao informado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function renderRestoreBlocked(target, err, context = {}) {
  const payload = err.payload || {};
  const operation = payload.operation || {};
  const backup = payload.runningBackup || {};
  const isBackup = payload.code === 'DATABASE_BACKUP_IN_PROGRESS';
  const title = isBackup ? 'Restore nao iniciado: backup em andamento' : 'Restore nao iniciado: operacao em andamento';
  const details = [
    context.uploadPath ? `<div><strong>Arquivo enviado:</strong> <code>${escapeHtml(context.uploadPath)}</code></div>` : '',
    `<div><strong>Banco:</strong> ${escapeHtml(payload.databaseName || operation.databaseName || context.databaseName || 'nao informado')}</div>`,
    `<div><strong>Motivo:</strong> ${escapeHtml(err.message)}</div>`,
    isBackup ? `<div><strong>Backup iniciado em:</strong> ${escapeHtml(formatDateTime(backup.startedAt))}</div>` : '',
    isBackup && backup.logPath ? `<div><strong>Log do backup:</strong> <code>${escapeHtml(backup.logPath)}</code></div>` : '',
    operation.operationKind ? `<div><strong>Operacao ativa:</strong> ${escapeHtml(operation.operationKind)}</div>` : '',
    operation.operationStartedAt ? `<div><strong>Inicio da operacao:</strong> ${escapeHtml(formatDateTime(operation.operationStartedAt))}</div>` : '',
    operation.operationExpiresAt ? `<div><strong>Expira em:</strong> ${escapeHtml(formatDateTime(operation.operationExpiresAt))}</div>` : ''
  ].filter(Boolean).join('');

  target.innerHTML = `<div class="alert alert-warning mt-3">
    <div class="fw-bold mb-2">${escapeHtml(title)}</div>
    <div class="mb-2">A restauracao ainda nao foi executada. Aguarde a rotina atual terminar e clique novamente em restaurar.</div>
    <div class="small">${details}</div>
  </div>`;
}

async function releaseRestorePrepare(operationToken) {
  if (!operationToken) return;
  try {
    await api('/api/restores/release', { method: 'POST', body: JSON.stringify({ operationToken }) });
  } catch (_) {
    // A reserva expira sozinha pelo TTL se a liberacao best-effort falhar.
  }
}

function startLogPolling(logPath, output) {
  let active = true;
  setVerboseStatus(output, 'em andamento', 'primary');
  const tick = async () => {
    if (!active) return;
    try {
      const data = await api(`/api/logs/tail?path=${encodeURIComponent(logPath)}`);
      output.textContent = data.exists ? (data.content || 'Log criado, aguardando novas linhas...') : 'Aguardando criacao do log...';
      output.scrollTop = output.scrollHeight;
    } catch (err) {
      output.textContent = err.message;
    }
  };
  tick();
  const timer = setInterval(tick, 1500);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function formatDuration(seconds) {
  const total = Math.max(num(seconds), 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function metricLatest(metrics, scope, target) {
  return (metrics?.latest || []).find(m => m.scope === scope && m.target === target) || {};
}

function metricSeries(metrics, scope, target, field) {
  return (metrics?.series || [])
    .filter(m => m.scope === scope && m.target === target && m[field] !== null && m[field] !== undefined)
    .map(m => ({ t: new Date(m.createdAt).getTime(), v: num(m[field]) }));
}

function percentColorClass(value) {
  const current = num(value);
  if (current >= 90) return 'crit';
  if (current >= 75) return 'warn';
  return 'ok';
}

function polar(cx, cy, r, angle) {
  const rad = (angle - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = polar(cx, cy, r, endAngle);
  const end = polar(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

function gaugeChart(value, label) {
  const current = Math.max(0, Math.min(num(value), 100));
  const angle = -120 + (current / 100) * 240;
  const needle = polar(110, 112, 58, angle);
  return `<svg class="zbx-gauge" viewBox="0 0 220 150" role="img" aria-label="${escapeHtml(label)} ${current.toFixed(1)}%">
    <path class="track" d="${arcPath(110, 112, 78, -120, 120)}"></path>
    <path class="ok" d="${arcPath(110, 112, 78, -120, 60)}"></path>
    <path class="warn" d="${arcPath(110, 112, 78, 60, 96)}"></path>
    <path class="crit" d="${arcPath(110, 112, 78, 96, 120)}"></path>
    <line class="needle" x1="110" y1="112" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}"></line>
    <circle class="center" cx="110" cy="112" r="7"></circle>
    <text x="48" y="132">0%</text>
    <text x="150" y="132">100%</text>
    <text class="gauge-number" x="110" y="92" text-anchor="middle">${current.toFixed(1)}%</text>
  </svg>`;
}

function lineChart(points, suffix = '', options = {}) {
  if (!points.length) {
    return `<svg class="zbx-chart" viewBox="0 0 520 180" role="img"><text class="axis-text" x="18" y="92">Sem dados coletados ainda</text></svg>`;
  }
  const width = 520;
  const height = 180;
  const pad = { top: 16, right: 16, bottom: 24, left: 42 };
  const minT = Math.min(...points.map(p => p.t));
  const maxT = Math.max(...points.map(p => p.t));
  const hardMax = options.max ?? null;
  const maxV = hardMax ?? Math.max(...points.map(p => p.v), options.warn || 0, options.crit || 0, 1);
  const minV = options.min ?? Math.min(...points.map(p => p.v), 0);
  const spanT = Math.max(maxT - minT, 1);
  const spanV = Math.max(maxV - minV, 1);
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const yFor = value => pad.top + chartH - ((value - minV) / spanV) * chartH;
  const coords = points.map(p => {
    const x = pad.left + ((p.t - minT) / spanT) * chartW;
    const y = yFor(p.v);
    return [x, y];
  });
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${height - pad.bottom} L${coords[0][0].toFixed(1)},${height - pad.bottom} Z`;
  const grid = [0, .25, .5, .75, 1].map(step => {
    const y = pad.top + chartH * step;
    const value = maxV - spanV * step;
    return `<line class="grid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line><text class="axis-text" x="6" y="${(y + 3).toFixed(1)}">${value.toFixed(value >= 10 ? 0 : 1)}${suffix}</text>`;
  }).join('');
  const warn = options.warn ? `<line class="warn-line" x1="${pad.left}" y1="${yFor(options.warn).toFixed(1)}" x2="${width - pad.right}" y2="${yFor(options.warn).toFixed(1)}"></line>` : '';
  const crit = options.crit ? `<line class="crit-line" x1="${pad.left}" y1="${yFor(options.crit).toFixed(1)}" x2="${width - pad.right}" y2="${yFor(options.crit).toFixed(1)}"></line>` : '';
  const firstLabel = new Date(minT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lastLabel = new Date(maxT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<svg class="zbx-chart" viewBox="0 0 ${width} ${height}" role="img">
    ${grid}
    ${warn}${crit}
    <path class="area" d="${area}"></path>
    <path class="line" d="${line}"></path>
    <text class="axis-text" x="${pad.left}" y="${height - 7}">${firstLabel}</text>
    <text class="axis-text" x="${width - pad.right - 42}" y="${height - 7}">${lastLabel}</text>
    <text class="axis-text" x="${width - pad.right - 86}" y="13">max ${maxV.toFixed(1)}${suffix}</text>
  </svg>`;
}

function zabbixMetricCard(title, value, subtitle, chart) {
  return `<div class="col-md-6 col-xl-3 metric-panel"><div class="card zbx-panel"><div class="card-body">
    <div class="zbx-title">${escapeHtml(title)}</div>
    ${chart}
    <div class="zbx-value mt-1">${escapeHtml(value)}</div>
    <div class="zbx-subtitle">${escapeHtml(subtitle || '')}</div>
  </div></div></div>`;
}

function zabbixGraphCard(title, subtitle, chart, columns = 'col-lg-6') {
  return `<div class="${columns}"><div class="card zbx-panel"><div class="card-body">
    <div class="zbx-title">${escapeHtml(title)}</div>
    ${chart}
    <div class="zbx-subtitle mt-2">${escapeHtml(subtitle || '')}</div>
  </div></div></div>`;
}

function latestPerContainer(metrics) {
  return (metrics?.latest || [])
    .filter(m => ['FIREBIRD', 'CONTAINER'].includes(m.scope))
    .filter(m => m.target !== 'tronfire_firebird25')
    .sort((a, b) => num(b.cpuPercent) - num(a.cpuPercent));
}

function alertSeverityClass(severity) {
  const value = String(severity || '').toUpperCase();
  if (value === 'CRITICAL' || value === 'HIGH') return 'danger';
  if (value === 'WARNING') return 'warning';
  return 'info';
}

function dashboardAlertShortcut(alerts) {
  const active = alerts || [];
  const first = active.slice(0, 3);
  return `<div class="card zbx-panel alert-shortcut h-100"><div class="card-body">
    <div class="d-flex align-items-start justify-content-between gap-3">
      <div>
        <div class="zbx-title mb-1">Alertas ativos</div>
        <div class="alert-shortcut-count">${active.length}</div>
        <div class="zbx-subtitle">Clique para investigar ocorrencias.</div>
      </div>
      <a class="alert-shortcut-icon text-decoration-none" href="#alerts" title="Ver alertas">!</a>
    </div>
    <div class="mt-3 alert-list">
      ${first.length ? first.map(a => `<div class="border-top py-2">
        <span class="badge bg-${alertSeverityClass(a.severity)} me-2">${escapeHtml(a.severity)}</span>${escapeHtml(a.message)}
      </div>`).join('') : '<div class="text-muted border-top pt-2">Nenhum alerta ativo.</div>'}
    </div>
    <a class="btn btn-sm btn-outline-primary mt-3" href="#alerts">Ver detalhes</a>
  </div></div>`;
}

async function dashboard() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const range = ['day', 'week', 'month'].includes(params.get('range')) ? params.get('range') : 'day';
  const data = await api(`/api/dashboard?range=${range}`);
  const prod = data.databases.find(d => d.isPrimary);
  const metrics = data.metrics || { latest: [], series: [] };
  const firebirdTarget = (metrics.latest || []).find(m => m.scope === 'FIREBIRD' && m.target === 'firebird_host')?.target
    || (metrics.latest || []).find(m => m.scope === 'FIREBIRD')?.target
    || 'tronfire_firebird25';
  const firebird = metricLatest(metrics, 'FIREBIRD', firebirdTarget);
  const dataDisk = metricLatest(metrics, 'SERVER', '/firebird/data');
  const backupDisk = metricLatest(metrics, 'SERVER', '/firebird/backups');
  const uptime = metricLatest(metrics, 'SERVER', 'firebird_uptime');
  const rangeLabel = { day: '24 horas', week: '7 dias', month: '30 dias' }[range];
  const firebirdCpu = metricSeries(metrics, 'FIREBIRD', firebirdTarget, 'cpuPercent');
  const firebirdMem = metricSeries(metrics, 'FIREBIRD', firebirdTarget, 'memoryPercent');
  const diskData = metricSeries(metrics, 'SERVER', '/firebird/data', 'diskUsedPercent');
  const diskBackup = metricSeries(metrics, 'SERVER', '/firebird/backups', 'diskUsedPercent');
  const netOut = metricSeries(metrics, 'FIREBIRD', firebirdTarget, 'netOutputBytes');
  const blockOut = metricSeries(metrics, 'FIREBIRD', firebirdTarget, 'blockOutputBytes');
  const dbSizeSeries = prod ? metricSeries(metrics, 'DATABASE', prod.alias, 'fileSizeBytes').map(p => ({ ...p, v: p.v / (1024 ** 3) })) : [];
  const dbMetricByAlias = new Map((metrics.latest || []).filter(m => m.scope === 'DATABASE').map(m => [m.target, m]));
  const topContainers = latestPerContainer(metrics).slice(0, 5);
  const backupOk = data.backups.filter(b => b.status === 'SUCCESS').length;
  const backupFailed = data.backups.filter(b => b.status === 'FAILED').length;
  content.innerHTML = `
    <div class="dashboard-toolbar">
      <div>
        <h2 class="page-title">Dashboard</h2>
        <div class="text-muted small">Monitoramento operacional do Firebird, bancos e backups.</div>
      </div>
      <div class="range-tabs" aria-label="Periodo dos graficos">
        <a class="btn btn-sm ${range === 'day' ? 'btn-primary' : 'btn-ghost-primary'}" href="#dashboard?range=day">24h</a>
        <a class="btn btn-sm ${range === 'week' ? 'btn-primary' : 'btn-ghost-primary'}" href="#dashboard?range=week">7d</a>
        <a class="btn btn-sm ${range === 'month' ? 'btn-primary' : 'btn-ghost-primary'}" href="#dashboard?range=month">30d</a>
      </div>
    </div>
    <div class="mb-3">
      ${dashboardAlertShortcut(data.alerts)}
    </div>
    <div class="row row-cards zbx-board mb-3">
      <div class="col-sm-6 col-xl-3"><div class="card summary-card"><div class="card-body"><div class="subheader">Bancos</div><div class="h1 mb-0">${data.databases.length}</div></div></div></div>
      <div class="col-sm-6 col-xl-3"><div class="card summary-card"><div class="card-body"><div class="subheader">Producao</div><div class="h3 mb-0 text-truncate">${escapeHtml(prod?.name || 'Nao definido')}</div></div></div></div>
      <div class="col-sm-6 col-xl-3"><div class="card summary-card"><div class="card-body"><div class="subheader">Alertas ativos</div><div class="h1 mb-0">${data.alerts.length}</div></div></div></div>
      <div class="col-sm-6 col-xl-3"><div class="card summary-card"><div class="card-body"><div class="subheader">Uptime Firebird</div><div class="h1 mb-0">${formatDuration(uptime.uptimeSeconds)}</div></div></div></div>
    </div>
    <div class="row row-cards">
      ${zabbixMetricCard('Firebird: uso de CPU em %', `${num(firebird.cpuPercent).toFixed(1)}%`, rangeLabel, gaugeChart(firebird.cpuPercent, 'CPU Firebird'))}
      ${zabbixMetricCard('Firebird: memoria usada em %', `${num(firebird.memoryPercent).toFixed(1)}%`, `${formatBytes(firebird.memoryUsageBytes)} de ${formatBytes(firebird.memoryLimitBytes)}`, gaugeChart(firebird.memoryPercent, 'Memoria Firebird'))}
      ${zabbixMetricCard('/firebird/data: disco usado em %', `${num(dataDisk.diskUsedPercent).toFixed(1)}%`, `${formatBytes(dataDisk.diskFreeBytes)} livre`, gaugeChart(dataDisk.diskUsedPercent, 'Disco dos bancos'))}
      ${zabbixMetricCard('/firebird/backups: disco usado em %', `${num(backupDisk.diskUsedPercent).toFixed(1)}%`, `${formatBytes(backupDisk.diskFreeBytes)} livre`, gaugeChart(backupDisk.diskUsedPercent, 'Disco de backups'))}
    </div>
    <div class="row row-cards">
      ${zabbixGraphCard('Firebird: historico de CPU em %', `Periodo: ${rangeLabel}`, lineChart(firebirdCpu, '%', { min: 0, max: 100, warn: 75, crit: 90 }))}
      ${zabbixGraphCard('Firebird: historico de memoria em %', `Periodo: ${rangeLabel}`, lineChart(firebirdMem, '%', { min: 0, max: 100, warn: 75, crit: 90 }))}
      ${zabbixGraphCard('/firebird/data: historico de disco em %', `Periodo: ${rangeLabel}`, lineChart(diskData, '%', { min: 0, max: 100, warn: 85, crit: 95 }))}
      ${zabbixGraphCard('/firebird/backups: historico de disco em %', `Periodo: ${rangeLabel}`, lineChart(diskBackup, '%', { min: 0, max: 100, warn: 85, crit: 95 }))}
      ${zabbixGraphCard('Firebird: trafego de saida por coleta', firebirdTarget === 'firebird_host' ? 'Indisponivel por processo no modo host' : 'Delta entre coletas do container', lineChart(netOut.map((p, i, arr) => i === 0 ? { ...p, v: 0 } : { ...p, v: Math.max(p.v - arr[i - 1].v, 0) }), 'B'))}
      ${zabbixGraphCard('Firebird: escrita em disco por coleta', firebirdTarget === 'firebird_host' ? 'Delta de I/O do processo no host' : 'Delta de Block I/O gravado', lineChart(blockOut.map((p, i, arr) => i === 0 ? { ...p, v: 0 } : { ...p, v: Math.max(p.v - arr[i - 1].v, 0) }), 'B'))}
      ${zabbixGraphCard(`Banco principal: crescimento em GB`, prod?.alias ? `Alias: ${prod.alias}` : 'Sem banco principal definido', lineChart(dbSizeSeries, 'GB'), 'col-lg-8')}
    </div>
    <div class="row row-cards">
      <div class="col-lg-8">
        <div class="card"><div class="card-header"><h3 class="card-title">Bancos monitorados</h3></div><div class="table-responsive">
          <table class="table"><thead><tr><th>Nome</th><th>Alias</th><th>Tipo</th><th>Status</th><th class="db-size">Tamanho</th><th>Ultima checagem</th></tr></thead>
          <tbody>${data.databases.map(d => {
            const metric = dbMetricByAlias.get(d.alias) || {};
            return `<tr><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.alias)}</td><td>${badge(d.type)}</td><td>${escapeHtml(d.status)}</td><td>${formatBytes(metric.fileSizeBytes)}</td><td>${d.lastCheckAt ? new Date(d.lastCheckAt).toLocaleString() : '-'}</td></tr>`;
          }).join('')}</tbody></table>
        </div></div>
      </div>
      <div class="col-lg-4">
        <div class="card zbx-panel mb-3"><div class="card-body">
          <div class="zbx-title">Containers por CPU</div>
          <div class="table-responsive">
            <table class="table table-sm mb-0"><thead><tr><th>Container</th><th>CPU</th><th>Mem.</th></tr></thead><tbody>
              ${topContainers.length ? topContainers.map(c => `<tr><td>${escapeHtml(c.target)}</td><td><span class="badge bg-${percentColorClass(c.cpuPercent) === 'crit' ? 'danger' : percentColorClass(c.cpuPercent) === 'warn' ? 'warning' : 'success'}">${num(c.cpuPercent).toFixed(1)}%</span></td><td>${num(c.memoryPercent).toFixed(1)}%</td></tr>`).join('') : '<tr><td colspan="3" class="text-muted">Sem dados de containers.</td></tr>'}
            </tbody></table>
          </div>
        </div></div>
        <div class="card"><div class="card-body">
          <div class="subheader">Backups</div>
          <div class="h2">${data.backups.length}</div>
          <div class="text-muted small">Ultimos registros: ${backupOk} sucesso, ${backupFailed} falha</div>
          <div class="mt-2 small">/firebird/backups: ${formatBytes(backupDisk.diskFreeBytes)} livre</div>
        </div></div>
      </div>
    </div>
  `;
}

function connectionPanel(info) {
  return `
    <div class="card mb-3" id="connectionPanel">
      <div class="card-header"><h3 class="card-title">Conexao - ${escapeHtml(info.name)}</h3></div>
      <div class="card-body">
        ${info.usingStandbyPath ? `<div class="alert alert-info mb-3">Este no esta em ${escapeHtml(info.nodeRole)}. A conexao abaixo aponta para o banco restaurado do standby em modo somente leitura. O caminho de producao sera usado apos a promocao.</div>` : ''}
        <div class="row g-3">
          <div class="col-md-3"><div class="subheader">Servidor</div><div>${escapeHtml(info.host)}</div></div>
          <div class="col-md-2"><div class="subheader">Porta global</div><div>${escapeHtml(info.port)}</div></div>
          <div class="col-md-4"><div class="subheader">Banco</div><code>${escapeHtml(info.path)}</code></div>
          <div class="col-md-3"><div class="subheader">Usuario</div><div>${escapeHtml(info.user)}</div></div>
          ${info.usingStandbyPath ? `<div class="col-md-6"><div class="subheader">Caminho de producao apos promocao</div><code>${escapeHtml(info.productionPath)}</code></div>` : ''}
        </div>
        <div class="mt-3">
          <label class="form-label">String por alias</label>
          <div class="input-group">
            <input class="form-control" readonly value="${escapeHtml(info.aliasConnection)}">
            <button class="btn btn-outline-primary" data-copy="${escapeHtml(info.aliasConnection)}">Copiar</button>
          </div>
        </div>
        <div class="mt-3">
          <label class="form-label">String com porta explicita</label>
          <div class="input-group">
            <input class="form-control" readonly value="${escapeHtml(info.withPort)}">
            <button class="btn btn-outline-primary" data-copy="${escapeHtml(info.withPort)}">Copiar</button>
          </div>
        </div>
        <div class="mt-3">
          <label class="form-label">String usando porta padrao do Firebird</label>
          <div class="input-group">
            <input class="form-control" readonly value="${escapeHtml(info.defaultPort)}">
            <button class="btn btn-outline-primary" data-copy="${escapeHtml(info.defaultPort)}">Copiar</button>
          </div>
        </div>
        <div class="text-muted small mt-3">Senha: valor configurado em FIREBIRD_PASSWORD no .env.</div>
      </div>
    </div>`;
}

function databaseDetailsPanel(db, diagnostic, haStatus) {
  const status = databaseStatusView(db, diagnostic);
  const diagnosticPath = diagnostic?.path || db.filePath;
  const usingStandbyPath = diagnostic?.pathRole === 'standby_read_only' || diagnosticPath !== db.filePath;
  return `
    <div class="card mb-3" id="databaseDetailsPanel">
      <div class="card-header d-flex align-items-center justify-content-between">
        <h3 class="card-title">Detalhes - ${escapeHtml(db.name)}</h3>
        <span class="badge bg-${status.className}" title="${escapeHtml(status.title)}">${escapeHtml(status.text)}</span>
      </div>
      <div class="card-body">
        <div class="alert alert-${status.className === 'success' ? 'success' : status.className === 'danger' ? 'danger' : 'info'} mb-3">${escapeHtml(status.title)}</div>
        ${usingStandbyPath ? `<div class="alert alert-info mb-3">Este standby esta exibindo os dados do arquivo restaurado em <code>${escapeHtml(diagnosticPath)}</code>. O arquivo de producao <code>${escapeHtml(db.filePath)}</code> so sera substituido na promocao.</div>` : ''}
        ${haOperationWarning(haStatus)}
        <div class="row g-3">
          <div class="col-md-3"><div class="subheader">Alias</div><div>${escapeHtml(db.alias)}</div></div>
          <div class="col-md-3"><div class="subheader">Tipo</div><div>${badge(db.type)}</div></div>
          <div class="col-md-3"><div class="subheader">Tamanho do banco</div><div>${diagnostic?.fileSizeBytes !== null && diagnostic?.fileSizeBytes !== undefined ? formatBytes(diagnostic.fileSizeBytes) : 'Nao informado'}</div></div>
          <div class="col-md-3"><div class="subheader">Versao</div><div>${escapeHtml(diagnostic?.version || 'Nao informado')}</div></div>
          <div class="col-md-3"><div class="subheader">Empresa Sintegra</div><div>${escapeHtml(diagnostic?.licensedUnit || 'Nao informado')}</div></div>
          <div class="col-md-6"><div class="subheader">Caminho consultado</div><code>${escapeHtml(diagnosticPath)}</code></div>
          ${usingStandbyPath ? `<div class="col-md-6"><div class="subheader">Caminho de producao</div><code>${escapeHtml(db.filePath)}</code></div>` : ''}
          ${db.standbyPath ? `<div class="col-md-6"><div class="subheader">Caminho standby</div><code>${escapeHtml(db.standbyPath)}</code></div>` : ''}
          ${db.standbyStatus ? `<div class="col-md-3"><div class="subheader">Status standby</div><div>${escapeHtml(db.standbyStatus)}</div></div>` : ''}
          <div class="col-md-3"><div class="subheader">Operacao</div><div>${operationBadge(db)}</div></div>
          ${db.operationStartedAt ? `<div class="col-md-3"><div class="subheader">Inicio operacao</div><div>${new Date(db.operationStartedAt).toLocaleString()}</div></div>` : ''}
          ${db.operationExpiresAt ? `<div class="col-md-3"><div class="subheader">Expira em</div><div>${new Date(db.operationExpiresAt).toLocaleString()}</div></div>` : ''}
          <div class="col-md-3"><div class="subheader">Ultima checagem</div><div>${db.lastCheckAt ? new Date(db.lastCheckAt).toLocaleString() : '-'}</div></div>
          <div class="col-md-3"><div class="subheader">Ultimo backup</div><div>${db.lastBackupAt ? new Date(db.lastBackupAt).toLocaleString() : '-'}</div></div>
          <div class="col-md-3"><div class="subheader">Backup automatico</div><div>${db.backupEnabled ? 'Ativo' : 'Inativo'}</div></div>
          <div class="col-md-3"><div class="subheader">Frequencia</div><div>${escapeHtml(db.backupFrequencyMinutes)} min</div></div>
          <div class="col-md-3"><div class="subheader">Retencao</div><div>${escapeHtml(db.retentionDays)} dias</div></div>
          ${diagnostic?.error ? `<div class="col-12"><div class="alert alert-danger mb-0">${escapeHtml(diagnostic.error)}</div></div>` : ''}
        </div>
        <div class="mt-3 btn-list">
          <button class="btn btn-sm btn-outline-dark" data-detail-connection="${db.id}">Conexao</button>
          <button class="btn btn-sm btn-outline-primary" data-detail-primary="${db.id}">Marcar producao</button>
          <button class="btn btn-sm btn-outline-secondary" data-detail-validate="${db.id}">Validar</button>
          <button class="btn btn-sm btn-outline-info" data-detail-online="${db.id}">gfix -online</button>
          <button class="btn btn-sm btn-outline-success" data-detail-backup="${db.id}">Backup agora</button>
          <button class="btn btn-sm btn-outline-danger" data-detail-maintenance="${db.id}">Manutencao automatica</button>
        </div>
        <div id="detailConnectionSlot" class="mt-3"></div>
      </div>
    </div>`;
}

function firebirdServiceCard(info) {
  const statusClass = ['running', 'active'].includes(info.status) ? 'success' : info.status === 'exited' || info.status === 'dead' || info.status === 'inactive' ? 'danger' : 'warning';
  const label = info.label || (info.mode === 'host' ? 'Servico Firebird no host' : 'Container Firebird geral');
  const name = info.mode === 'host' ? (info.service || 'firebird') : info.container;
  const warning = info.mode === 'host'
    ? 'Estas acoes sao gerais e afetam o servico Firebird 2.5.9 instalado no host Debian.'
    : 'Estas acoes sao gerais e afetam todos os bancos atendidos por este container Firebird.';
  const actions = currentUser?.role === 'ADMIN'
    ? `<div class="btn-list">
        <button class="btn btn-outline-success" data-firebird-action="start">Iniciar</button>
        <button class="btn btn-outline-warning" data-firebird-action="restart">Reiniciar</button>
        <button class="btn btn-outline-danger" data-firebird-action="stop">Parar</button>
      </div>`
    : '<div class="alert alert-info mb-0">Somente administradores podem iniciar, parar ou reiniciar o Firebird.</div>';
  return `<div class="card mb-3"><div class="card-body">
    <div class="d-flex flex-wrap align-items-start justify-content-between gap-3">
      <div>
        <div class="subheader">${escapeHtml(label)}</div>
        <div class="h2 mb-1"><span class="service-dot bg-${statusClass}"></span>${escapeHtml(name)}</div>
        <div class="text-muted">Status: ${escapeHtml(info.status)}${info.details ? ` - ${escapeHtml(info.details)}` : ''}</div>
      </div>
      ${actions}
    </div>
    <div class="alert alert-warning mt-3 mb-0">${escapeHtml(warning)}</div>
  </div></div>`;
}

function bindFirebirdActions(refresh) {
  document.querySelectorAll('[data-firebird-action]').forEach(btn => btn.onclick = async () => {
    const action = btn.dataset.firebirdAction;
    const labels = { start: 'iniciar', stop: 'parar', restart: 'reiniciar' };
    const ok = await appDialog({
      title: 'Confirmar acao no Firebird',
      message: `Deseja ${labels[action]} o Firebird geral?\n\nIsso afeta todos os bancos.`,
      confirmText: labels[action][0].toUpperCase() + labels[action].slice(1),
      cancelText: 'Cancelar',
      variant: action === 'stop' ? 'danger' : 'warning'
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Executando...';
    await api(`/api/services/firebird/${action}`, { method: 'POST' });
    setTimeout(refresh, 900);
  });
}

async function databases() {
  const [dbs, diagnosticData, firebirdInfo, haStatus] = await Promise.all([
    api('/api/databases'),
    api('/api/preflight'),
    api('/api/services/firebird'),
    api('/api/ha/status').catch(() => null)
  ]);
  const hasProductionDatabase = dbs.some(db => db.isPrimary || db.type === 'PRODUCAO');
  const diagnosticById = new Map((diagnosticData.databases || []).map(db => [db.id, db]));
  content.innerHTML = `
    <div class="page-header"><h2 class="page-title">Bancos</h2></div>
    ${firebirdServiceCard(firebirdInfo)}
    <div id="connectionSlot"></div>
    <div id="databaseDetailsSlot"></div>
    <div class="card mb-3"><div class="card-body">
      <h3>Criar banco</h3>
      <div class="row g-2">
        <div class="col-md"><input id="dbName" class="form-control" placeholder="Nome do cliente"></div>
        <div class="col-md"><input id="dbAlias" class="form-control" placeholder="erp_tronsoft" value="${hasProductionDatabase ? '' : 'ERP_TRONSOFT'}" ${hasProductionDatabase ? '' : 'readonly'}></div>
        <div class="col-md"><select id="dbType" class="form-select"><option value="PRODUCAO">Producao</option><option value="LEGADO_CONSULTA">Legado/Consulta</option><option value="HOMOLOGACAO">Homologacao</option></select></div>
        <div class="col-auto"><button id="btnAddDb" class="btn btn-primary">Criar</button></div>
        <div class="col-12"><div class="form-text">O primeiro banco de producao usa obrigatoriamente o alias erp_tronsoft.</div></div>
        <div class="col-12"><div id="dbError" class="text-danger small mt-2"></div></div>
      </div>
    </div></div>
    <div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Nome</th><th>Alias</th><th>Status</th><th>Tipo</th><th>Operacao</th><th>Producao</th><th>Backup</th><th>Acoes</th></tr></thead><tbody>${dbs.map(d => {
      const diagnostic = diagnosticById.get(d.id);
      const status = databaseStatusView(d, diagnostic);
      return `<tr>
        <td>${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.alias)}</td>
        <td title="${escapeHtml(status.title)}"><span class="status-dot bg-${status.className}"></span>${escapeHtml(status.text)}</td>
        <td>${badge(d.type)}</td>
        <td>${operationBadge(d)}</td>
        <td>${d.isPrimary ? 'Sim' : 'Nao'}</td>
        <td>
          <div class="d-flex flex-wrap align-items-end gap-2">
            <input class="form-check-input m-0" type="checkbox" title="Ativar backup automatico" data-backup-enabled="${d.id}" ${d.backupEnabled ? 'checked' : ''}>
            <div class="small text-muted">
              <div>Automatico: 10 min</div>
              <div>Retencao: 30 dias</div>
            </div>
          </div>
        </td>
        <td><button class="btn btn-sm btn-outline-primary" data-details="${d.id}">Detalhes</button> <button class="btn btn-sm btn-outline-warning" data-save-backup="${d.id}">Salvar backup</button></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;

  const syncAliasLock = () => {
    const firstProduction = !hasProductionDatabase && dbType.value === 'PRODUCAO';
    dbAlias.readOnly = firstProduction;
    if (firstProduction) {
      dbAlias.value = 'ERP_TRONSOFT';
    } else if (dbAlias.value === 'ERP_TRONSOFT') {
      dbAlias.value = '';
    }
  };
  dbType.onchange = syncAliasLock;
  syncAliasLock();

  btnAddDb.onclick = async () => {
    try {
      dbError.textContent = '';
      const isProduction = dbType.value === 'PRODUCAO';
      const alias = !hasProductionDatabase && isProduction ? 'ERP_TRONSOFT' : dbAlias.value;
      await api('/api/databases', { method:'POST', body: JSON.stringify({ name: dbName.value, alias, type: dbType.value, isPrimary: isProduction, accessMode: dbType.value === 'LEGADO_CONSULTA' ? 'READ_ONLY':'READ_WRITE', backupEnabled: isProduction }) });
      databases();
    } catch (err) {
      dbError.textContent = err.message;
    }
  };
  bindFirebirdActions(databases);
  document.querySelectorAll('[data-details]').forEach(b => b.onclick = () => {
    const db = dbs.find(item => item.id === b.dataset.details);
    if (!db) return;
    databaseDetailsSlot.innerHTML = databaseDetailsPanel(db, diagnosticById.get(db.id), haStatus);
    databaseDetailsSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const bindCopy = root => root.querySelectorAll('[data-copy]').forEach(copy => copy.onclick = async () => {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = 'Copiado';
      setTimeout(() => { copy.textContent = 'Copiar'; }, 1200);
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-connection]').forEach(btn => btn.onclick = async () => {
      const info = await api(`/api/databases/${btn.dataset.detailConnection}/connection`);
      detailConnectionSlot.innerHTML = connectionPanel(info);
      bindCopy(detailConnectionSlot);
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-primary]').forEach(btn => btn.onclick = async () => {
      await api(`/api/databases/${btn.dataset.detailPrimary}/mark-primary`, { method:'POST' });
      databases();
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-validate]').forEach(btn => btn.onclick = async () => {
      await appAlert('Validacao concluida', JSON.stringify(await api(`/api/databases/${btn.dataset.detailValidate}/validate`, { method:'POST' }), null, 2));
      databases();
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-online]').forEach(btn => btn.onclick = async () => {
      const ok = await appDialog({
        title: 'Executar gfix -online',
        message: `Isso vai executar gfix -online no banco ${db.name} (${db.alias}).\n\nUse quando o ERP conecta, mas o banco ficou em modo shutdown/maintenance ou limitado a uma conexao ativa.`,
        confirmText: 'Executar',
        cancelText: 'Cancelar',
        variant: 'warning'
      });
      if (!ok) return;
      try {
        btn.disabled = true;
        btn.textContent = 'Executando...';
        const out = await api(`/api/databases/${btn.dataset.detailOnline}/online`, { method: 'POST' });
        await appAlert('Banco colocado online', `gfix -online executado.\nLog: ${out.logPath}`, 'success');
        databases();
      } catch (err) {
        await appAlert('Falha no gfix -online', `${err.message}\nLog: ${err.payload?.logPath || 'Nao informado'}`, 'danger');
        btn.disabled = false;
        btn.textContent = 'gfix -online';
      }
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-backup]').forEach(btn => btn.onclick = async () => {
      const token = operationToken();
      const logPath = logPathFor('backup', db.alias, token);
      const verbose = renderVerboseBox(detailConnectionSlot, 'Backup em andamento...', logPath);
      const stopPolling = startLogPolling(logPath, verbose);
      try {
        btn.disabled = true;
        btn.textContent = 'Backup...';
        const out = await api(`/api/backups/${btn.dataset.detailBackup}/run`, { method:'POST', body: JSON.stringify({ logToken: token }) });
        stopPolling();
        await finishVerbose(logPath, verbose, `Backup concluido.\n${JSON.stringify(out, null, 2)}`);
        setTimeout(() => { databases(); }, 1200);
      } catch (err) {
        stopPolling();
        await finishVerbose(logPath, verbose, `Erro no backup: ${err.message}`, 'danger');
        btn.disabled = false;
        btn.textContent = 'Backup agora';
      }
    });
    databaseDetailsSlot.querySelectorAll('[data-detail-maintenance]').forEach(btn => btn.onclick = async () => {
      const ok = await appDialog({
        title: 'Confirmar manutencao automatica',
        message: 'A manutencao automatica vai colocar o banco em modo manutencao, criar copia de seguranca, gerar GBK, restaurar e substituir o arquivo original pelo restaurado validado.\n\nEm HA primary, suspenda o failover no standby pelo TronSoftOS antes de continuar.\n\nExecute com usuarios fora do sistema. Deseja continuar?',
        confirmText: 'Executar manutencao',
        cancelText: 'Cancelar',
        variant: 'danger'
      });
      if (!ok) return;
      try {
        btn.disabled = true;
        btn.textContent = 'Manutencao...';
        detailConnectionSlot.innerHTML = `<div class="alert alert-warning mb-3">Manutencao do banco em andamento. Se este ambiente estiver em HA, mantenha o failover suspenso no standby ate concluir e validar o banco.</div>`;
        const out = await api(`/api/databases/${btn.dataset.detailMaintenance}/auto-maintenance`, { method: 'POST' });
        await appAlert('Manutencao concluida', `Tamanho antes: ${formatBytes(out.databaseSizeBefore)}\nTamanho depois: ${formatBytes(out.databaseSizeAfter)}\nBackup: ${out.backupPath}\nCopia anterior: ${out.safetyCopyPath}\nLog: ${out.logPath}`, 'success');
        databases();
      } catch (err) {
        await appAlert('Falha na manutencao', `${err.message}\nLog: ${err.payload?.logPath || 'Nao informado'}\nCopia anterior: ${err.payload?.safetyCopyPath || 'Nao informada'}`, 'danger');
        databases();
      }
    });
  });
  document.querySelectorAll('[data-save-backup]').forEach(b => b.onclick = async () => {
    const id = b.dataset.saveBackup;
    const enabled = document.querySelector(`[data-backup-enabled="${id}"]`).checked;
    await api(`/api/databases/${id}/backup-settings`, { method:'PATCH', body: JSON.stringify({ backupEnabled: enabled }) });
    b.textContent = 'Salvo';
    setTimeout(() => { databases(); }, 600);
  });
}

async function uploads() {
  const [dbs, serverUploads] = await Promise.all([api('/api/databases'), api('/api/uploads')]);
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Migracao GBK / FBK</h2></div>
    <div class="card mb-3"><div class="card-body">
      <h3>Enviar arquivo pelo navegador</h3>
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Banco escolhido</label>
          <select id="restoreDb" class="form-select">${dbs.map(d => `<option value="${d.id}" data-alias="${escapeHtml(d.alias)}">${escapeHtml(d.name)} (${escapeHtml(d.alias)})</option>`).join('')}</select>
        </div>
        <div class="col-md-8">
          <label class="form-label">Arquivo .GBK/.FBK</label>
          <input id="gbkFile" type="file" class="form-control" accept=".gbk,.fbk,.gz">
        </div>
      </div>
      <div class="progress mt-3 hidden" id="uploadProgressWrap">
        <div id="uploadProgress" class="progress-bar" style="width:0%">0%</div>
      </div>
      <div class="btn-list mt-3">
        <button id="btnGbk" class="btn btn-danger">Enviar e substituir banco escolhido</button>
        <button id="btnCancelUpload" class="btn btn-outline-secondary hidden" type="button">Cancelar upload</button>
      </div>
      <div id="gbkOut" class="mt-3"></div>
    </div></div>
    <div class="card"><div class="card-body">
      <h3>Usar arquivo ja copiado no servidor</h3>
      <div class="text-muted small mb-3">Copie o arquivo para /opt/tronfire-storage/firebird/uploads e use esta opcao para evitar upload pelo navegador.</div>
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Banco escolhido</label>
          <select id="serverRestoreDb" class="form-select">${dbs.map(d => `<option value="${d.id}" data-alias="${escapeHtml(d.alias)}">${escapeHtml(d.name)} (${escapeHtml(d.alias)})</option>`).join('')}</select>
        </div>
        <div class="col-md-8">
          <label class="form-label">Arquivo no servidor</label>
          <select id="serverUploadPath" class="form-select">${serverUploads.length ? serverUploads.map(file => `<option value="${escapeHtml(file.path)}">${escapeHtml(file.name)} - ${formatBytes(file.size)} - ${new Date(file.modifiedAt).toLocaleString()}</option>`).join('') : '<option value="">Nenhum arquivo encontrado em /firebird/uploads</option>'}</select>
        </div>
      </div>
      <button id="btnServerRestore" class="btn btn-warning mt-3" ${serverUploads.length ? '' : 'disabled'}>Restaurar arquivo do servidor</button>
      <div id="serverRestoreOut" class="mt-3"></div>
    </div></div>`;
  btnGbk.onclick = async () => {
    try {
      if (!gbkFile.files[0]) throw new Error('Selecione um arquivo .GBK ou .FBK');
      const selected = restoreDb.options[restoreDb.selectedIndex];
      const ok = await appDialog({
        title: 'Confirmar restauracao manual',
        message: `O arquivo sera restaurado sobre o banco: ${selected.text}.\n\nIsso substitui o banco escolhido. Confirme apenas se os usuarios estiverem fora do sistema.`,
        confirmText: 'Restaurar e substituir',
        cancelText: 'Cancelar',
        variant: 'danger'
      });
      if (!ok) {
        gbkOut.textContent = 'Restore cancelado pelo usuario.';
        return;
      }
      btnGbk.disabled = true;
      let preparedOperationToken = null;
      try {
        gbkOut.innerHTML = '<div class="alert alert-info mb-0"><strong>Preparando migração...</strong><br>Reservando o banco para impedir backup/sync enquanto o arquivo é enviado e restaurado.</div>';
        const prepared = await api('/api/restores/prepare', { method: 'POST', body: JSON.stringify({ databaseId: restoreDb.value }) });
        preparedOperationToken = prepared.operation?.operationToken;
      } catch (err) {
        if (err.code === 'DATABASE_BACKUP_IN_PROGRESS' || err.code === 'DATABASE_OPERATION_IN_PROGRESS') {
          renderRestoreBlocked(gbkOut, err, { databaseName: selected.text });
          await appAlert('Restore nao iniciado', `${err.message}\n\nA restauracao nao foi executada. Aguarde a rotina atual finalizar e tente novamente.`, 'warning');
          btnGbk.disabled = false;
          return;
        }
        throw err;
      }
      uploadProgressWrap.classList.remove('hidden');
      uploadProgress.style.width = '0%';
      uploadProgress.textContent = '0%';
      gbkOut.textContent = 'Enviando arquivo...';
      const f = new FormData();
      f.append('file', gbkFile.files[0]);
      btnCancelUpload.classList.remove('hidden');
      const uploadRequest = apiFormProgress('/api/uploads/gbk', f, percent => {
        uploadProgress.style.width = `${percent}%`;
        uploadProgress.textContent = `${percent}%`;
        gbkOut.textContent = `Enviando arquivo... ${percent}%`;
      });
      btnCancelUpload.onclick = () => uploadRequest.abort();
      let uploaded;
      try {
        uploaded = await uploadRequest.promise;
      } catch (err) {
        await releaseRestorePrepare(preparedOperationToken);
        throw err;
      }
      btnCancelUpload.classList.add('hidden');
      const token = operationToken();
      const logPath = logPathFor('restore', selected.dataset.alias, token);
      const verbose = renderVerboseBox(gbkOut, 'Restaurando e substituindo o banco escolhido...', logPath);
      const stopPolling = startLogPolling(logPath, verbose);
      let restored;
      try {
        restored = await api('/api/restores/from-upload', { method: 'POST', body: JSON.stringify({ uploadPath: uploaded.path, databaseId: restoreDb.value, logToken: token, operationToken: preparedOperationToken }) });
      } catch (err) {
        if (err.status === 401) {
          stopPolling();
          await releaseRestorePrepare(preparedOperationToken);
          verbose.textContent = `Upload concluido, mas a sessao expirou antes de iniciar a restauracao.\n\nArquivo enviado: ${uploaded.path}\n\nEntre novamente no TronFire e use a opcao "Usar arquivo ja copiado no servidor" para restaurar este arquivo.`;
          setVerboseStatus(verbose, 'sessao expirada', 'warning');
          btnGbk.disabled = false;
          btnCancelUpload.classList.add('hidden');
          return;
        }
        stopPolling();
        if (err.code === 'DATABASE_BACKUP_IN_PROGRESS' || err.code === 'DATABASE_OPERATION_IN_PROGRESS') {
          await releaseRestorePrepare(preparedOperationToken);
          renderRestoreBlocked(gbkOut, err, { uploadPath: uploaded.path, databaseName: selected.text });
          await appAlert('Restore nao iniciado', `${err.message}\n\nA restauracao nao foi executada. Aguarde a rotina atual finalizar e tente novamente.`, 'warning');
          btnGbk.disabled = false;
          btnCancelUpload.classList.add('hidden');
          return;
        }
        await finishVerbose(logPath, verbose, `Erro no restore: ${err.message}`, 'danger');
        await appAlert('Falha no restore', `${err.message}\nLog: ${err.payload?.logPath || logPath}`, 'danger');
        btnGbk.disabled = false;
        btnCancelUpload.classList.add('hidden');
        return;
      }
      stopPolling();
      await finishVerbose(logPath, verbose, `Restore concluido.\n${JSON.stringify(restored, null, 2)}`);
      await appAlert('Restore concluido', `Banco substituido com sucesso.\nLog: ${restored.logPath || logPath}`, 'success');
      btnGbk.disabled = false;
    } catch (err) {
      gbkOut.textContent = err.message;
      btnGbk.disabled = false;
      btnCancelUpload.classList.add('hidden');
    }
  };
  btnServerRestore.onclick = async () => {
    try {
      if (!serverUploadPath.value) throw new Error('Nenhum arquivo no servidor foi selecionado');
      const selected = serverRestoreDb.options[serverRestoreDb.selectedIndex];
      const file = serverUploadPath.options[serverUploadPath.selectedIndex];
      const ok = await appDialog({
        title: 'Confirmar restauracao manual',
        message: `O arquivo ${file.text} sera restaurado sobre o banco: ${selected.text}.\n\nIsso substitui o banco escolhido. Confirme apenas se os usuarios estiverem fora do sistema.`,
        confirmText: 'Restaurar e substituir',
        cancelText: 'Cancelar',
        variant: 'danger'
      });
      if (!ok) {
        serverRestoreOut.textContent = 'Restore cancelado pelo usuario.';
        return;
      }
      btnServerRestore.disabled = true;
      let preparedOperationToken = null;
      try {
        serverRestoreOut.innerHTML = '<div class="alert alert-info mb-0"><strong>Preparando migração...</strong><br>Reservando o banco para impedir backup/sync enquanto o arquivo é restaurado.</div>';
        const prepared = await api('/api/restores/prepare', { method: 'POST', body: JSON.stringify({ databaseId: serverRestoreDb.value }) });
        preparedOperationToken = prepared.operation?.operationToken;
      } catch (err) {
        if (err.code === 'DATABASE_BACKUP_IN_PROGRESS' || err.code === 'DATABASE_OPERATION_IN_PROGRESS') {
          renderRestoreBlocked(serverRestoreOut, err, { uploadPath: serverUploadPath.value, databaseName: selected.text });
          await appAlert('Restore nao iniciado', `${err.message}\n\nA restauracao nao foi executada. Aguarde a rotina atual finalizar e tente novamente.`, 'warning');
          return;
        }
        throw err;
      }
      const token = operationToken();
      const logPath = logPathFor('restore', selected.dataset.alias, token);
      const verbose = renderVerboseBox(serverRestoreOut, 'Restaurando e substituindo o banco escolhido...', logPath);
      const stopPolling = startLogPolling(logPath, verbose);
      try {
        const restored = await api('/api/restores/from-upload', { method: 'POST', body: JSON.stringify({ uploadPath: serverUploadPath.value, databaseId: serverRestoreDb.value, logToken: token, operationToken: preparedOperationToken }) });
        stopPolling();
        await finishVerbose(logPath, verbose, `Restore concluido.\n${JSON.stringify(restored, null, 2)}`);
        await appAlert('Restore concluido', `Banco substituido com sucesso.\nLog: ${restored.logPath || logPath}`, 'success');
      } catch (err) {
        stopPolling();
        if (err.code === 'DATABASE_BACKUP_IN_PROGRESS' || err.code === 'DATABASE_OPERATION_IN_PROGRESS') {
          await releaseRestorePrepare(preparedOperationToken);
          renderRestoreBlocked(serverRestoreOut, err, { uploadPath: serverUploadPath.value, databaseName: selected.text });
          await appAlert('Restore nao iniciado', `${err.message}\n\nA restauracao nao foi executada. Aguarde a rotina atual finalizar e tente novamente.`, 'warning');
          return;
        }
        await releaseRestorePrepare(preparedOperationToken);
        await finishVerbose(logPath, verbose, `Erro no restore: ${err.message}`, 'danger');
        await appAlert('Falha no restore', `${err.message}\nLog: ${err.payload?.logPath || logPath}`, 'danger');
      }
    } catch (err) {
      serverRestoreOut.textContent = err.message;
    } finally {
      btnServerRestore.disabled = false;
    }
  };
}
async function backups() {
  const [jobs, cleanupPreview] = await Promise.all([
    api('/api/backups'),
    api('/api/backups/cleanup/preview?olderThanDays=7&keepLastPerDatabase=1')
  ]);
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Backups</h2></div>
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">Limpeza de disco</h3></div><div class="card-body">
      <div class="row g-3 align-items-end">
        <div class="col-md-3">
          <label class="form-label">Excluir backups com mais de</label>
          <div class="input-group"><input id="cleanupDays" class="form-control" type="number" min="0" value="7"><span class="input-group-text">dias</span></div>
        </div>
        <div class="col-md-3">
          <label class="form-label">Manter por banco</label>
          <div class="input-group"><input id="cleanupKeep" class="form-control" type="number" min="0" value="1"><span class="input-group-text">ultimos</span></div>
        </div>
        <div class="col-md-6 d-flex flex-wrap gap-2">
          <button id="btnPreviewCleanup" class="btn btn-outline-primary">Calcular limpeza</button>
          <button id="btnRunCleanup" class="btn btn-danger">Executar limpeza</button>
        </div>
        <div class="col-12">
          <div id="cleanupStatus" class="small text-muted">Prévia padrão: ${cleanupPreview.count} backup(s), ${formatBytes(cleanupPreview.totalBytes)} liberáveis.</div>
          <div class="text-muted small mt-1">A limpeza remove apenas arquivos em /firebird/backups registrados como sucesso. Bancos ativos, uploads de restore e logs não são removidos.</div>
        </div>
      </div>
    </div></div>
    <div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Banco</th><th>Status</th><th>Validacao</th><th>Externo</th><th>Arquivo</th><th>Tamanho</th><th>Data</th><th>Acoes</th></tr></thead><tbody>${jobs.map(j => {
    const externalText = j.driveStatus === 'UPLOADED'
      ? `Google Drive OK${j.driveWebLink ? ` - ${escapeHtml(j.driveWebLink)}` : ''}`
      : j.driveStatus === 'TRONSOFTOS'
        ? 'TronSoftOS'
        : `${escapeHtml(j.driveStatus || 'TRONSOFTOS')}${j.driveErrorMessage ? ` - ${escapeHtml(j.driveErrorMessage)}` : ''}`;
    const validationText = j.validation?.ok
      ? `Restaurado OK${j.validation.validatedAt ? ` - ${new Date(j.validation.validatedAt).toLocaleString()}` : ''}`
      : j.status === 'SUCCESS' ? 'Nao validado' : '-';
    return `<tr><td>${escapeHtml(j.database?.name || '')}</td><td>${escapeHtml(j.status)}</td><td>${escapeHtml(validationText)}</td><td>${externalText}</td><td>${escapeHtml(j.backupPath || '')}</td><td>${formatBytes(j.backupSize || 0)}</td><td>${new Date(j.createdAt).toLocaleString()}</td><td>${j.status === 'SUCCESS' ? `<a class="btn btn-sm btn-outline-primary" href="${apiUrl(`/api/backups/${j.id}/download`)}">Download</a>` : escapeHtml(j.errorMessage || '')}</td></tr>`;
  }).join('')}</tbody></table></div></div>`;
  const cleanupQuery = () => `olderThanDays=${encodeURIComponent(cleanupDays.value || 0)}&keepLastPerDatabase=${encodeURIComponent(cleanupKeep.value || 0)}`;
  btnPreviewCleanup.onclick = async () => {
    try {
      cleanupStatus.className = 'small text-muted';
      cleanupStatus.textContent = 'Calculando...';
      const preview = await api(`/api/backups/cleanup/preview?${cleanupQuery()}`);
      cleanupStatus.className = preview.count ? 'small text-warning' : 'small text-success';
      cleanupStatus.textContent = `${preview.count} backup(s) podem ser removidos, liberando ${formatBytes(preview.totalBytes)}.`;
    } catch (err) {
      cleanupStatus.className = 'small text-danger';
      cleanupStatus.textContent = err.message;
    }
  };
  btnRunCleanup.onclick = async () => {
    try {
      const preview = await api(`/api/backups/cleanup/preview?${cleanupQuery()}`);
      if (!preview.count) {
        cleanupStatus.className = 'small text-success';
        cleanupStatus.textContent = 'Nenhum backup elegivel para limpeza.';
        return;
      }
      const ok = await appDialog({
        title: 'Confirmar limpeza de backups',
        message: `Serão removidos ${preview.count} backup(s), liberando aproximadamente ${formatBytes(preview.totalBytes)}.\n\nEsta ação remove os arquivos locais e os registros da lista de backups. Continuar?`,
        confirmText: 'Excluir backups',
        cancelText: 'Cancelar',
        variant: 'danger'
      });
      if (!ok) return;
      cleanupStatus.className = 'small text-muted';
      cleanupStatus.textContent = 'Removendo backups...';
      const out = await api('/api/backups/cleanup', {
        method: 'POST',
        body: JSON.stringify({ olderThanDays: Number(cleanupDays.value || 0), keepLastPerDatabase: Number(cleanupKeep.value || 0) })
      });
      cleanupStatus.className = out.failedCount ? 'small text-warning' : 'small text-success';
      cleanupStatus.textContent = `Limpeza concluida: ${out.deletedCount} removido(s), ${out.failedCount} falha(s), ${formatBytes(out.totalBytes)} liberados.`;
      setTimeout(backups, 1200);
    } catch (err) {
      cleanupStatus.className = 'small text-danger';
      cleanupStatus.textContent = err.message;
    }
  };
}

function queryFromFilters(ids) {
  const params = new URLSearchParams();
  for (const [key, id] of Object.entries(ids)) {
    const value = document.getElementById(id)?.value;
    if (value) params.set(key, value);
  }
  return params.toString();
}

async function alerts() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('status') || 'active';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const data = await api(`/api/alerts?status=${encodeURIComponent(status)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Alertas</h2></div>
    <div class="card mb-3"><div class="card-body">
      <div class="row g-2 align-items-end">
        <div class="col-md-3"><label class="form-label">Status</label><select id="alertStatus" class="form-select"><option value="active">Ativos</option><option value="all">Todos</option><option value="resolved">Resolvidos</option></select></div>
        <div class="col-md-3"><label class="form-label">De</label><input id="alertFrom" type="date" class="form-control" value="${escapeHtml(from)}"></div>
        <div class="col-md-3"><label class="form-label">Ate</label><input id="alertTo" type="date" class="form-control" value="${escapeHtml(to)}"></div>
        <div class="col-md-3"><button id="btnFilterAlerts" class="btn btn-primary w-100">Filtrar</button></div>
      </div>
    </div></div>
    <div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Severidade</th><th>Mensagem</th><th>Tipo</th><th>Data</th><th>Status</th><th>Acoes</th></tr></thead><tbody>
      ${data.length ? data.map(a => `<tr>
        <td><span class="badge bg-${alertSeverityClass(a.severity)}">${escapeHtml(a.severity)}</span></td>
        <td>${escapeHtml(a.message)}</td>
        <td>${escapeHtml(a.type)}</td>
        <td>${new Date(a.createdAt).toLocaleString()}</td>
        <td>${a.resolved ? 'Resolvido' : 'Ativo'}</td>
        <td>${!a.resolved && currentUser?.role !== 'CONSULTA' ? `<button class="btn btn-sm btn-outline-success" data-resolve-alert="${a.id}">Resolver</button>` : '-'}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="text-muted">Nenhum alerta encontrado.</td></tr>'}
    </tbody></table></div></div>`;
  alertStatus.value = status;
  btnFilterAlerts.onclick = () => {
    const query = queryFromFilters({ status: 'alertStatus', from: 'alertFrom', to: 'alertTo' });
    location.hash = `#alerts?${query}`;
  };
  document.querySelectorAll('[data-resolve-alert]').forEach(btn => btn.onclick = async () => {
    await api(`/api/alerts/${btn.dataset.resolveAlert}/resolve`, { method: 'PATCH' });
    alerts();
  });
}

async function logs() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const source = params.get('source') || 'all';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const data = await api(`/api/logs?source=${encodeURIComponent(source)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Logs</h2></div>
    <div class="card mb-3"><div class="card-body">
      <div class="row g-2 align-items-end">
        <div class="col-md-3"><label class="form-label">Origem</label><select id="logSource" class="form-select"><option value="all">Todos</option><option value="firebird">Firebird</option><option value="audit">Auditoria</option></select></div>
        <div class="col-md-3"><label class="form-label">De</label><input id="logFrom" type="date" class="form-control" value="${escapeHtml(from)}"></div>
        <div class="col-md-3"><label class="form-label">Ate</label><input id="logTo" type="date" class="form-control" value="${escapeHtml(to)}"></div>
        <div class="col-md-3"><button id="btnFilterLogs" class="btn btn-primary w-100">Filtrar</button></div>
      </div>
    </div></div>
    <div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Origem</th><th>Nome</th><th>Data</th><th>Tamanho</th><th>Usuario</th><th>Acoes</th></tr></thead><tbody>
      ${data.length ? data.map((item, index) => `<tr>
        <td><span class="badge bg-${item.source === 'firebird' ? 'azure' : 'secondary'}">${escapeHtml(item.source)}</span></td>
        <td>${escapeHtml(item.name)}</td>
        <td>${new Date(item.createdAt).toLocaleString()}</td>
        <td>${item.size !== undefined ? formatBytes(item.size) : '-'}</td>
        <td>${escapeHtml(item.user || '-')}</td>
        <td><button class="btn btn-sm btn-outline-primary" data-log-preview="${index}">Ver</button></td>
      </tr><tr class="hidden" data-log-row="${index}"><td colspan="6"><pre class="log-preview mb-0">${escapeHtml(item.preview || 'Sem conteudo para exibicao.')}</pre></td></tr>`).join('') : '<tr><td colspan="6" class="text-muted">Nenhum log encontrado.</td></tr>'}
    </tbody></table></div></div>`;
  logSource.value = source;
  btnFilterLogs.onclick = () => {
    const query = queryFromFilters({ source: 'logSource', from: 'logFrom', to: 'logTo' });
    location.hash = `#logs?${query}`;
  };
  document.querySelectorAll('[data-log-preview]').forEach(btn => btn.onclick = () => {
    const row = document.querySelector(`[data-log-row="${btn.dataset.logPreview}"]`);
    row?.classList.toggle('hidden');
  });
}

async function services() {
  const info = await api('/api/services/firebird');
  const statusClass = ['running', 'active'].includes(info.status) ? 'success' : info.status === 'exited' || info.status === 'dead' || info.status === 'inactive' ? 'danger' : 'warning';
  const label = info.label || (info.mode === 'host' ? 'Servico Firebird no host' : 'Container Firebird geral');
  const name = info.mode === 'host' ? (info.service || 'firebird') : info.container;
  const warning = info.mode === 'host'
    ? 'Estas acoes sao gerais e afetam o servico Firebird 2.5.9 instalado no host Debian.'
    : 'Estas acoes sao gerais e afetam todos os bancos atendidos por este container Firebird.';
  const logsTitle = info.mode === 'host' ? 'Logs/status recentes do servico' : 'Logs recentes do container';
  const actions = currentUser?.role === 'ADMIN'
    ? `<div class="btn-list">
        <button class="btn btn-outline-success" data-firebird-action="start">Iniciar</button>
        <button class="btn btn-outline-warning" data-firebird-action="restart">Reiniciar</button>
        <button class="btn btn-outline-danger" data-firebird-action="stop">Parar</button>
      </div>`
    : '<div class="alert alert-info mb-0">Somente administradores podem iniciar, parar ou reiniciar o Firebird.</div>';
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Servicos</h2></div>
    <div class="card mb-3"><div class="card-body">
      <div class="d-flex flex-wrap align-items-start justify-content-between gap-3">
        <div>
          <div class="subheader">${escapeHtml(label)}</div>
          <div class="h2 mb-1"><span class="service-dot bg-${statusClass}"></span>${escapeHtml(name)}</div>
          <div class="text-muted">Status: ${escapeHtml(info.status)}${info.details ? ` - ${escapeHtml(info.details)}` : ''}</div>
        </div>
        ${actions}
      </div>
      <div class="alert alert-warning mt-3 mb-0">${escapeHtml(warning)}</div>
    </div></div>
    <div class="card"><div class="card-header"><h3 class="card-title">${escapeHtml(logsTitle)}</h3></div><div class="card-body"><pre class="log-preview mb-0">${escapeHtml(info.logs || 'Sem logs recentes.')}</pre></div></div>`;
  document.querySelectorAll('[data-firebird-action]').forEach(btn => btn.onclick = async () => {
    const action = btn.dataset.firebirdAction;
    const labels = { start: 'iniciar', stop: 'parar', restart: 'reiniciar' };
    const ok = await appDialog({
      title: 'Confirmar acao no Firebird',
      message: `Deseja ${labels[action]} o Firebird geral?\n\nIsso afeta todos os bancos.`,
      confirmText: labels[action][0].toUpperCase() + labels[action].slice(1),
      cancelText: 'Cancelar',
      variant: action === 'stop' ? 'danger' : 'warning'
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Executando...';
    await api(`/api/services/firebird/${action}`, { method: 'POST' });
    setTimeout(() => { services(); }, 900);
  });
}

async function settings() {
  const cloudflare = await api('/api/settings/cloudflare-tunnel');
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Configuracoes</h2></div>
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">Cloudflare Tunnel</h3></div><div class="card-body">
      <div class="row g-3">
        <div class="col-12">
          <div class="alert alert-info mb-0">
            Configure um Tunnel no painel da Cloudflare apontando para <code>http://backend:8080</code> e cole o token aqui quando o acesso publico do TronFire for necessario.
          </div>
        </div>
        <div class="col-12">
          <label class="form-check">
            <input id="cloudflareEnabled" class="form-check-input" type="checkbox" ${cloudflare.enabled ? 'checked' : ''}>
            <span class="form-check-label">Usar Cloudflare Tunnel para URL publica do TronFire</span>
          </label>
        </div>
        <div class="col-md-7">
          <label class="form-label">URL publica do TronFire</label>
          <input id="cloudflarePublicUrl" class="form-control" placeholder="https://cliente.seudominio.com.br" value="${escapeHtml(cloudflare.publicUrl || '')}">
        </div>
        <div class="col-md-5">
          <label class="form-label">Token do Tunnel</label>
          <input id="cloudflareToken" class="form-control" type="password" placeholder="${cloudflare.tokenConfigured ? 'Ja salvo - informe apenas para trocar' : 'Cole o token do cloudflared'}">
        </div>
        <div class="col-12 d-flex flex-wrap gap-2">
          <button id="btnSaveCloudflare" class="btn btn-primary">Salvar tunnel</button>
          <button id="btnStartCloudflare" class="btn btn-success">Iniciar tunnel</button>
          <button id="btnStopCloudflare" class="btn btn-outline-danger">Parar tunnel</button>
        </div>
        <div class="col-12">
          <div id="cloudflareStatus" class="small mt-2">Container: ${escapeHtml(cloudflare.container)} - Status: ${escapeHtml(cloudflare.status)}${cloudflare.updatedAt ? ` - Ultima alteracao: ${new Date(cloudflare.updatedAt).toLocaleString()}` : ''}</div>
          <pre class="log-preview mt-2 mb-0">${escapeHtml(cloudflare.logs || 'Sem logs recentes.')}</pre>
        </div>
      </div>
    </div></div>
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">Backup em nuvem</h3></div><div class="card-body">
      <div class="alert alert-info mb-0">
        Google Drive/rclone e configurado no TronSoftOS. O TronFire mantem os backups locais e registra o status como gerenciado pelo TronSoftOS.
      </div>
    </div></div>`;
  const cloudflarePayload = () => ({
    enabled: cloudflareEnabled.checked,
    publicUrl: cloudflarePublicUrl.value.trim().replace(/^http:\/\//i, 'https://'),
    token: cloudflareToken.value
  });
  const renderCloudflareResult = result => {
    cloudflareToken.value = '';
    cloudflareStatus.className = result.status === 'running' ? 'small mt-2 text-success' : 'small mt-2 text-muted';
    cloudflareStatus.textContent = `Container: ${result.container} - Status: ${result.status}`;
  };
  btnSaveCloudflare.onclick = async () => {
    try {
      cloudflareStatus.className = 'small mt-2 text-muted';
      cloudflareStatus.textContent = 'Salvando tunnel...';
      renderCloudflareResult(await api('/api/settings/cloudflare-tunnel', { method: 'PATCH', body: JSON.stringify(cloudflarePayload()) }));
      cloudflarePublicUrl.value = cloudflarePayload().publicUrl;
    } catch (err) {
      cloudflareStatus.className = 'small mt-2 text-danger';
      cloudflareStatus.textContent = err.message;
    }
  };
  btnStartCloudflare.onclick = async () => {
    try {
      cloudflareStatus.className = 'small mt-2 text-muted';
      cloudflareStatus.textContent = 'Salvando e iniciando tunnel...';
      await api('/api/settings/cloudflare-tunnel', { method: 'PATCH', body: JSON.stringify(cloudflarePayload()) });
      renderCloudflareResult(await api('/api/settings/cloudflare-tunnel/start', { method: 'POST', body: JSON.stringify({}) }));
      cloudflarePublicUrl.value = cloudflarePayload().publicUrl;
    } catch (err) {
      cloudflareStatus.className = 'small mt-2 text-danger';
      cloudflareStatus.textContent = err.message;
    }
  };
  btnStopCloudflare.onclick = async () => {
    try {
      cloudflareStatus.className = 'small mt-2 text-muted';
      cloudflareStatus.textContent = 'Parando tunnel...';
      renderCloudflareResult(await api('/api/settings/cloudflare-tunnel/stop', { method: 'POST', body: JSON.stringify({}) }));
    } catch (err) {
      cloudflareStatus.className = 'small mt-2 text-danger';
      cloudflareStatus.textContent = err.message;
    }
  };
}

async function preflight() {
  const r = await api('/api/preflight');
  content.innerHTML = `<div class="page-header"><h2 class="page-title">Diagnostico</h2></div>
    <div class="card mb-3"><div class="card-body"><h3>${r.ok ? 'Ambiente OK' : 'Ambiente com problemas'}</h3><ul class="list-group">${r.checks.map(c => `<li class="list-group-item"><span class="status-dot bg-${c.ok ? 'success':'danger'}"></span>${escapeHtml(c.message)}</li>`).join('')}</ul></div></div>`;
}

async function route() {
  const hash = location.hash || '#dashboard';
  const baseHash = hash.split('?')[0];
  try {
    if (currentUser?.role === 'CONSULTA' && !['#dashboard', '#alerts', '#preflight'].includes(baseHash)) {
      location.hash = '#dashboard';
      return dashboard();
    }
    if (baseHash === '#databases') return databases();
    if (baseHash === '#uploads') return uploads();
    if (baseHash === '#backups') return backups();
    if (baseHash === '#alerts') return alerts();
    if (baseHash === '#logs') return logs();
    if (baseHash === '#services') {
      location.hash = '#databases';
      return databases();
    }
    if (baseHash === '#settings') return settings();
    if (baseHash === '#preflight') return preflight();
    return dashboard();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
(async () => { try { const me = await api('/api/auth/me'); showApp(me.user); } catch { showLogin(); } })();
