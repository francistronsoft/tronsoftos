import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Cloud,
  Database,
  ExternalLink,
  FileClock,
  CheckCircle2,
  Gauge,
  GitBranch,
  HardDrive,
  LayoutDashboard,
  LogIn,
  LogOut,
  Moon,
  Network,
  Play,
  Power,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Thermometer,
  UploadCloud,
  XCircle,
  Zap
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import ReactFlow, { Background, Controls, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'apps', label: 'Apps', icon: Boxes },
  { id: 'tronfire', label: 'TronFire', icon: Database },
  { id: 'cluster', label: 'Cluster HA', icon: GitBranch },
  { id: 'backups', label: 'Backups', icon: UploadCloud },
  { id: 'cloudflare', label: 'Cloudflare', icon: Cloud },
  { id: 'updates', label: 'Atualizacoes', icon: RefreshCw },
  { id: 'maintenance', label: 'Manutencao', icon: Power }
];

const fallbackDashboard = {
  generatedAt: new Date().toISOString(),
  cluster: {
    mode: 'simple',
    nodeName: 'local',
    nodeRole: 'primary',
    vip: 'nao configurado',
    lock: null,
    keepalived: { enabled: false, interface: null, routerId: null },
    vipStatus: null
  },
  apps: [
    {
      name: 'tronfire',
      enabled: true,
      status: 'offline',
      health: { ok: false, status: 'offline', url: 'http://127.0.0.1:8081/health' },
      containers: [
        { name: 'tronfire_backend', status: 'unknown', detail: 'aguardando backend' },
        { name: 'tronfire_worker', status: 'unknown', detail: 'aguardando backend' }
      ],
      haAware: true
    },
    {
      name: 'troncomanda',
      enabled: false,
      status: 'disabled',
      health: { ok: null, status: 'not-configured' },
      containers: [{ name: 'troncomanda', status: 'missing', detail: 'fontes pendentes' }],
      haAware: false
    }
  ],
    backups: {
    backupDir: '/opt/tronfire-storage/firebird/backups',
    rclone: { remote: null, path: null, uploadOnlyRole: 'primary' },
    quota: null,
    recentFiles: []
  },
  cloudflare: { recordName: null, recordType: 'A', targetIp: null, tokenConfigured: false },
  systemMetrics: { latest: [], series: [] },
  alerts: [{ severity: 'warning', message: 'Backend ainda nao retornou dados reais' }]
};

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep default HTTP message.
    }
    throw new Error(message);
  }
  return response.json();
}

async function postApi(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function statusClass(status) {
  return {
    online: 'bg-green-100 text-green-800 border-green-200',
    running: 'bg-green-100 text-green-800 border-green-200',
    primary: 'bg-green-100 text-green-800 border-green-200',
    success: 'bg-green-100 text-green-800 border-green-200',
    prepared: 'bg-sky-100 text-sky-800 border-sky-200',
    READY: 'bg-green-100 text-green-800 border-green-200',
    critical: 'bg-red-100 text-red-800 border-red-200',
    degraded: 'bg-amber-100 text-amber-800 border-amber-200',
    warning: 'bg-amber-100 text-amber-800 border-amber-200',
    atrasado: 'bg-amber-100 text-amber-800 border-amber-200',
    deferred: 'bg-amber-100 text-amber-800 border-amber-200',
    blocked: 'bg-red-100 text-red-800 border-red-200',
    'promotion-allowed': 'bg-amber-100 text-amber-800 border-amber-200',
    standby: 'bg-blue-100 text-blue-800 border-blue-200',
    receptor: 'bg-blue-100 text-blue-800 border-blue-200',
    recovery: 'bg-violet-100 text-violet-800 border-violet-200',
    disabled: 'bg-slate-100 text-slate-700 border-slate-200',
    offline: 'bg-red-100 text-red-800 border-red-200',
    missing: 'bg-red-100 text-red-800 border-red-200',
    error: 'bg-red-100 text-red-800 border-red-200'
  }[status] || 'bg-slate-100 text-slate-700 border-slate-200';
}

function StatusPill({ value }) {
  return <span className={`inline-flex items-center rounded border px-2 py-1 text-xs font-medium ${statusClass(value)}`}>{value || 'unknown'}</span>;
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = size;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current >= 10 || unit === 0 ? Math.round(current) : current.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value) {
  const current = Number(value);
  return Number.isFinite(current) ? `${current.toFixed(1)}%` : '-';
}

function formatTemperature(value) {
  const current = Number(value);
  return Number.isFinite(current) ? `${current.toFixed(1)} °C` : '-';
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium'
  });
}

function formatDurationFrom(value) {
  if (!value) return '-';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
}

function diagnosticIcon(status) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  return <XCircle className="h-4 w-4 text-red-600" />;
}

function Card({ title, icon: Icon, children, action, className = '' }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white shadow-soft ${className}`}>
      <header className="flex min-h-12 items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          {Icon ? <Icon className="h-4 w-4 text-slate-500" /> : null}
          {title}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, detail, icon: Icon, tone = 'slate' }) {
  const toneClass = {
    green: 'bg-green-50 text-green-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    sky: 'bg-sky-50 text-sky-700',
    slate: 'bg-slate-100 text-slate-700'
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase text-slate-500">{label}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
          <div className="mt-1 min-h-5 text-sm text-slate-500">{detail}</div>
        </div>
        <div className={`rounded-md p-2 ${toneClass}`}>{Icon ? <Icon className="h-5 w-5" /> : null}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', readOnly = false, autoComplete }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        autoComplete={autoComplete}
        onChange={event => onChange?.(event.target.value)}
        className={`mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 ${readOnly ? 'bg-slate-50 text-slate-500' : ''}`}
      />
    </label>
  );
}

function Checkbox({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
      />
      {label}
    </label>
  );
}

function SubTabs({ items, active, onChange }) {
  return (
    <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
      {items.map(item => {
        const selected = item.id === active;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${selected ? 'bg-slate-950 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function ServiceNode({ data }) {
  return (
    <div className="min-w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-soft">
      <Handle type="target" position={Position.Left} />
      <div className="font-semibold text-slate-900">{data.label}</div>
      <div className="mt-1 text-xs text-slate-500">{data.detail}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { service: ServiceNode };

function Topology({ dashboard }) {
  const cluster = dashboard.cluster;
  const tronfire = dashboard.apps.find(app => app.name === 'tronfire');
  const nodes = [
    { id: 'cloudflare', type: 'service', position: { x: 20, y: 40 }, data: { label: 'Cloudflare', detail: dashboard.cloudflare.recordName || 'DNS/Tunnel' } },
    { id: 'vip', type: 'service', position: { x: 250, y: 40 }, data: { label: 'VIP', detail: cluster.vip || 'nao configurado' } },
    { id: 'primary', type: 'service', position: { x: 480, y: 0 }, data: { label: cluster.nodeName || 'Servidor', detail: cluster.nodeRole || 'primary' } },
    { id: 'standby', type: 'service', position: { x: 480, y: 110 }, data: { label: 'Standby', detail: cluster.mode === 'ha' ? 'aguardando sync' : 'desativado' } },
    { id: 'firebird', type: 'service', position: { x: 700, y: 0 }, data: { label: 'Firebird Host', detail: '2.5.9 / porta 3050' } },
    { id: 'tronfire', type: 'service', position: { x: 920, y: 0 }, data: { label: 'TronFire', detail: tronfire?.status || 'unknown' } },
    { id: 'backup', type: 'service', position: { x: 920, y: 110 }, data: { label: 'Rclone', detail: dashboard.backups.rclone.remote || 'sem remote' } }
  ];
  const edges = [
    { id: 'e1', source: 'cloudflare', target: 'vip', animated: true },
    { id: 'e2', source: 'vip', target: 'primary' },
    { id: 'e3', source: 'primary', target: 'standby', animated: cluster.mode === 'ha' },
    { id: 'e4', source: 'primary', target: 'firebird' },
    { id: 'e5', source: 'firebird', target: 'tronfire' },
    { id: 'e6', source: 'tronfire', target: 'backup', animated: !!dashboard.backups.rclone.remote }
  ];
  return (
    <div className="h-72 rounded-lg border border-slate-200 bg-slate-50">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}>
        <Background gap={18} color="#dbe3ef" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function DashboardView({ dashboard }) {
  const onlineApps = dashboard.apps.filter(app => app.status === 'online').length;
  const alerts = dashboard.alerts || [];
  const isStandbyNode = ['standby', 'recovery'].includes(dashboard.cluster.nodeRole);
  const sync = dashboard.cluster.sync || {};
  const standbyDbSummary = sync.tronfireStandby?.databaseCount
    ? `${sync.tronfireStandby.readyCount || 0}/${sync.tronfireStandby.databaseCount}`
    : '-';
  const syncReceiverDetail = sync.tronfireStandby?.latestValidatedAt
    ? `restore ${formatDateTime(sync.tronfireStandby.latestValidatedAt)}`
    : sync.receiver?.latestBackup?.modifiedAt
      ? `backup ${formatDateTime(sync.receiver.latestBackup.modifiedAt)}`
      : 'aguardando primary';
  const readyCount = Number(sync.tronfireStandby?.readyCount || 0);
  const databaseCount = Number(sync.tronfireStandby?.databaseCount || 0);
  const databaseProgress = databaseCount ? Math.round((readyCount / databaseCount) * 70) : 0;
  const promotionProgress = Math.min(100, databaseProgress + (sync.standbyReady ? 20 : 0) + (dashboard.cluster.guard?.canPromote ? 10 : 0));
  const promotionState = dashboard.cluster.guard?.canPromote
    ? 'promocao autorizada, aguardando acionamento'
    : sync.standbyReady
      ? 'standby pronto, promocao ainda nao executada'
      : 'standby em sincronizacao';
  const promotionDetail = dashboard.cluster.guard?.canServeProduction
    ? 'Este no ja esta servindo producao.'
    : dashboard.cluster.guard?.canPromote
      ? 'A promocao esta liberada, mas so ocorre se o watchdog detectar queda do primary ou se o tecnico acionar manualmente.'
      : 'Ainda nao houve promocao. O standby continua recebendo/validando backups e aguardando autorizacao.';
  const localBuild = dashboard.build || dashboard.cluster.build || {};
  const standbyBuild = dashboard.cluster.standbyHealth || {};
  const buildValue = build => build?.buildNumber ? `Build ${build.buildNumber}` : (build?.version || '-');
  const buildDetail = build => `versao ${build?.version || '-'}`;
  const buildsDifferClient = (left, right) => Boolean(
    (left?.buildNumber && right?.buildNumber && left.buildNumber !== right.buildNumber)
    || (left?.commit && right?.commit && left.commit !== right.commit)
    || (left?.version && right?.version && left.version !== right.version)
  );
  const hostMetrics = dashboard.systemMetrics || {};
  const hostLatest = (hostMetrics.latest || []).find(metric => metric.scope === 'HOST' && metric.target) || {};
  const hardwareSeries = (hostMetrics.series || [])
    .filter(metric => metric.scope === 'HOST' && metric.target)
    .map(metric => ({
      time: new Date(metric.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      cpu: Number(metric.cpuPercent ?? 0),
      memory: Number(metric.memoryPercent ?? 0),
      disk: Number(metric.diskUsedPercent ?? 0),
      temperature: metric.temperatureCelsius === null || metric.temperatureCelsius === undefined ? null : Number(metric.temperatureCelsius)
    }));
  const temperatureValue = Number(hostLatest.temperatureCelsius);
  const temperatureTone = Number.isFinite(temperatureValue)
    ? temperatureValue >= 85 ? 'red' : temperatureValue >= 70 ? 'amber' : 'green'
    : 'slate';
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-5">
        <Stat label="No atual" value={dashboard.cluster.nodeName} detail={dashboard.cluster.mode} icon={Server} tone="sky" />
        <Stat label="Papel" value={dashboard.cluster.nodeRole} detail={dashboard.cluster.vip || 'VIP nao configurado'} icon={ShieldCheck} tone="green" />
        <Stat label="Apps online" value={`${onlineApps}/${dashboard.apps.length}`} detail="containers gerenciados" icon={Boxes} tone="slate" />
        <Stat label="Alertas" value={alerts.length} detail={alerts[0]?.message || 'sem alertas ativos'} icon={AlertTriangle} tone={alerts.length ? 'amber' : 'green'} />
        <Stat label="Hora servidor" value={formatDateTime(dashboard.generatedAt)} detail="gerado pelo backend" icon={FileClock} tone="slate" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Stat label="Versao local" value={buildValue(localBuild)} detail={buildDetail(localBuild)} icon={GitBranch} tone="slate" />
        {isStandbyNode ? (
          <Stat label="Versao deste standby" value={buildValue(localBuild)} detail={buildDetail(localBuild)} icon={GitBranch} tone="green" />
        ) : (
          <Stat label="Versao standby" value={buildValue(standbyBuild)} detail={dashboard.cluster.standbyHealth?.ok ? buildDetail(standbyBuild) : dashboard.cluster.standbyHealth?.error || 'nao consultado'} icon={GitBranch} tone={dashboard.cluster.standbyHealth?.ok ? (buildsDifferClient(localBuild, standbyBuild) ? 'amber' : 'green') : 'slate'} />
        )}
        {isStandbyNode ? (
          <Stat label="Sync recebido" value={sync.standbyReady ? 'operando' : standbyDbSummary} detail={syncReceiverDetail} icon={RefreshCw} tone={sync.standbyReady ? 'green' : 'amber'} />
        ) : (
          <Stat label="Standby restaurado" value={standbyDbSummary} detail={sync.tronfireStandby?.latestValidatedAt ? `restore ${formatDateTime(sync.tronfireStandby.latestValidatedAt)}` : 'nao validado'} icon={ShieldCheck} tone={sync.standbyReady ? 'green' : 'amber'} />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="CPU host" value={formatPercent(hostLatest.cpuPercent)} detail={hostLatest.createdAt ? `coleta ${formatDateTime(hostLatest.createdAt)}` : 'aguardando coleta'} icon={Activity} tone="sky" />
        <Stat label="Memoria host" value={formatPercent(hostLatest.memoryPercent)} detail={`${formatBytes(hostLatest.memoryUsageBytes)} de ${formatBytes(hostLatest.memoryLimitBytes)}`} icon={Gauge} tone="green" />
        <Stat label="Disco host" value={formatPercent(hostLatest.diskUsedPercent)} detail={`${formatBytes(hostLatest.diskFreeBytes)} livre`} icon={HardDrive} tone="slate" />
        <Stat label="Temperatura" value={formatTemperature(hostLatest.temperatureCelsius)} detail={hostLatest.temperatureCelsius === null || hostLatest.temperatureCelsius === undefined ? 'sensor indisponivel' : hostLatest.createdAt ? `coleta ${formatDateTime(hostLatest.createdAt)}` : 'aguardando coleta'} icon={Thermometer} tone={temperatureTone} />
      </div>
      {isStandbyNode ? (
        <Card title="Preparacao para promocao" icon={ShieldCheck} action={<StatusPill value={sync.standbyReady ? 'READY' : 'standby'} />}>
          <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-center">
            <div>
              <div className="text-sm font-semibold text-slate-900">{promotionState}</div>
              <div className="mt-1 text-sm text-slate-500">
                Bancos prontos {standbyDbSummary}. {promotionDetail}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-sky-600" style={{ width: `${promotionProgress}%` }} />
              </div>
            </div>
            <div className="grid gap-2 text-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">Restore</span><span className="font-medium">{readyCount}/{databaseCount || '-'}</span></div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">Defasagem</span><span className="font-medium">{sync.standbyLagMinutes === null || sync.standbyLagMinutes === undefined ? '-' : `${sync.standbyLagMinutes} min`}</span></div>
              <div className="flex items-center justify-between"><span className="text-slate-500">Promocao</span><span className="font-medium">{dashboard.cluster.guard?.canServeProduction ? 'executada' : dashboard.cluster.guard?.canPromote ? 'liberada' : 'nao executada'}</span></div>
            </div>
          </div>
        </Card>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card title="Topologia" icon={GitBranch}><Topology dashboard={dashboard} /></Card>
        <Card title="Saude" icon={Gauge}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={hardwareSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="time" fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip />
                <Area type="monotone" dataKey="cpu" stroke="#0284c7" fill="#bae6fd" />
                <Area type="monotone" dataKey="memory" stroke="#16a34a" fill="#bbf7d0" />
                <Area type="monotone" dataKey="disk" stroke="#64748b" fill="#cbd5e1" />
                <Area type="monotone" dataKey="temperature" stroke="#f97316" fill="#fed7aa" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {!hardwareSeries.length ? <div className="mt-2 text-xs text-slate-500">Historico de hardware ainda nao coletado pelo TronFire.</div> : null}
        </Card>
      </div>
      <Card title="Alertas ativos" icon={AlertTriangle} action={<StatusPill value={alerts.length ? 'warning' : 'online'} />}>
        {alerts.length ? (
          <div className="grid gap-2">
            {alerts.slice(0, 8).map((alert, index) => (
              <div key={`${alert.message}-${index}`} className={`flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm ${alert.severity === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                <span>{alert.message}</span>
                <StatusPill value={alert.severity === 'critical' ? 'critical' : 'warning'} />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            Nenhum alerta ativo no TronSoftOS ou TronFire.
          </div>
        )}
      </Card>
    </div>
  );
}

function AppsView({ dashboard, onAction, actionPending, actionJob }) {
  return (
    <div className="space-y-4">
      {actionJob ? <ActionTerminal job={actionJob} /> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {dashboard.apps.map(app => (
          <Card key={app.name} title={app.name} icon={Boxes} action={<StatusPill value={app.status} />}>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <button disabled={actionPending} onClick={() => onAction(app.name, 'up')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Play className="h-4 w-4" />Subir</button>
              <button disabled={actionPending} onClick={() => onAction(app.name, 'restart')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Reiniciar</button>
              <button disabled={actionPending} onClick={() => onAction(app.name, 'stop')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Square className="h-4 w-4" />Parar</button>
              {app.publicUrl ? (
                <a href={app.publicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"><ExternalLink className="h-4 w-4" />Acessar</a>
              ) : (
                <button disabled className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium opacity-50"><ExternalLink className="h-4 w-4" />Acessar</button>
              )}
            </div>
            <div className="space-y-2">
              {app.containers.map(container => (
                <div key={container.name} className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{container.name}</div>
                    <div className="text-xs text-slate-500">{container.detail}</div>
                  </div>
                  <StatusPill value={container.status} />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ActionTerminal({ job }) {
  const output = [job.stdout, job.stderr].filter(Boolean).join('\n').trim();
  const statusText = job.status === 'running' ? 'Executando' : job.status === 'success' ? 'Concluido' : 'Falhou';
  return (
    <Card title={`Execucao: ${job.app} ${job.action}`} icon={Terminal} action={<StatusPill value={job.status} />}>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>{statusText}</span>
        <span className="font-mono">{job.command} {(job.args || []).join(' ')}</span>
        {job.exitCode !== null && job.exitCode !== undefined ? <span>exit {job.exitCode}</span> : null}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">{output || 'Aguardando saida do comando...'}</pre>
      {job.error ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{job.error}</div> : null}
    </Card>
  );
}

function InlineTerminal({ job }) {
  const output = [job.stdout, job.stderr].filter(Boolean).join('\n').trim();
  const statusText = job.status === 'running' ? 'Executando' : job.status === 'success' ? 'Concluido' : 'Falhou';
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <StatusPill value={job.status} />
        <span>{statusText}</span>
        <span className="font-mono">{job.command} {(job.args || []).join(' ')}</span>
        {job.exitCode !== null && job.exitCode !== undefined ? <span>exit {job.exitCode}</span> : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">{output || 'Aguardando saida do comando...'}</pre>
      {job.error ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{job.error}</div> : null}
    </div>
  );
}

function DiagnosticsView() {
  const diagnosticsQuery = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api('/api/diagnostics'),
    refetchInterval: 10000
  });
  const diagnostics = diagnosticsQuery.data;
  const checks = diagnostics?.checks || [];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="Estado geral" value={diagnostics?.summary?.ok ? 'OK' : 'Atencao'} detail={diagnosticsQuery.isFetching ? 'atualizando' : diagnostics?.generatedAt ? new Date(diagnostics.generatedAt).toLocaleTimeString() : 'aguardando'} icon={ShieldCheck} tone={diagnostics?.summary?.ok ? 'green' : 'amber'} />
        <Stat label="Erros" value={String(diagnostics?.summary?.errors ?? '-')} detail="checagens criticas" icon={XCircle} tone={(diagnostics?.summary?.errors || 0) > 0 ? 'red' : 'green'} />
        <Stat label="Avisos" value={String(diagnostics?.summary?.warnings ?? '-')} detail="itens pendentes" icon={AlertTriangle} tone={(diagnostics?.summary?.warnings || 0) > 0 ? 'amber' : 'green'} />
        <Stat label="Firebird" value={diagnostics?.firebird?.status || '-'} detail={diagnostics?.tronfire?.firebirdExecMode || 'modo desconhecido'} icon={Database} tone={diagnostics?.firebird?.status === 'active' ? 'green' : 'red'} />
      </div>

      <div className="grid gap-5">
        <Card title="Checklist da instalacao" icon={CheckCircle2} action={<button onClick={() => diagnosticsQuery.refetch()} className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Atualizar</button>}>
          <div className="space-y-2">
            {diagnosticsQuery.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{diagnosticsQuery.error.message}</div> : null}
            {checks.map(check => (
              <div key={check.id || check.label} className="grid gap-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-3 text-sm md:grid-cols-[220px_90px_1fr]">
                <div className="flex items-center gap-2 font-medium text-slate-900">
                  {diagnosticIcon(check.status)}
                  {check.label}
                </div>
                <StatusPill value={check.status} />
                <div className="min-w-0 text-slate-600">
                  <div className="truncate">{check.detail || '-'}</div>
                  {check.path || check.dbPath ? <div className="mt-1 truncate font-mono text-xs text-slate-400">{check.path || check.dbPath}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function ClusterView({ dashboard }) {
  const queryClient = useQueryClient();
  const cluster = dashboard.cluster;
  const identityQuery = useQuery({ queryKey: ['node-identity'], queryFn: () => api('/api/node-identity') });
  const lockQuery = useQuery({ queryKey: ['cluster-lock'], queryFn: () => api('/api/cluster/lock') });
  const guardQuery = useQuery({ queryKey: ['cluster-guard'], queryFn: () => api('/api/cluster/guard'), refetchInterval: 5000 });
  const syncQuery = useQuery({ queryKey: ['ha-sync-settings'], queryFn: () => api('/api/cluster/sync'), refetchInterval: 10000 });
  const [networkProposal, setNetworkProposal] = useState('');
  const networkImpactQuery = useQuery({
    queryKey: ['cluster-network-impact', networkProposal],
    queryFn: () => api(`/api/cluster/network-impact${networkProposal ? `?proposed=${encodeURIComponent(networkProposal)}` : ''}`),
    refetchInterval: 10000
  });
  const identity = identityQuery.data || cluster.identity || {};
  const lock = lockQuery.data || cluster.lock || {};
  const guard = guardQuery.data || cluster.guard || {};
  const networkImpact = networkImpactQuery.data || {};
  const sync = syncQuery.data || {};
  const syncStatus = cluster.sync || sync || {};
  const vipStatus = cluster.vipStatus || {};
  const vipHolder = vipStatus.holder || {};
  const vipHolderLabel = vipHolder.nodeName ? `${vipHolder.nodeName}${vipHolder.nodeRole ? ` / ${vipHolder.nodeRole}` : ''}` : (vipStatus.reachable ? 'no sem nome' : 'nao identificado');
  const vipCardStatus = !vipStatus.vip ? 'disabled' : vipStatus.ok ? 'online' : vipStatus.reachable ? 'warning' : 'offline';
  const vipLocalExpected = vipStatus.expectedLocalPresence === true ? 'sim' : vipStatus.expectedLocalPresence === false ? 'nao' : '-';
  const [form, setForm] = useState(null);
  const [lockForm, setLockForm] = useState(null);
  const [syncForm, setSyncForm] = useState(null);
  const [vipForm, setVipForm] = useState(null);
  const [syncJobId, setSyncJobId] = useState(null);
  const [clusterTab, setClusterTab] = useState('overview');
  const [selectedHaLog, setSelectedHaLog] = useState('');
  const values = form || {
    clusterId: identity.clusterId || 'local',
    nodeName: identity.nodeName || cluster.nodeName || 'servidor-01',
    nodeRole: identity.nodeRole || cluster.nodeRole || 'primary',
    deploymentMode: identity.deploymentMode || cluster.mode || 'simple'
  };
  const isSyncReceiver = values.deploymentMode === 'ha' && ['standby', 'recovery'].includes(values.nodeRole);
  const standbyDbStatusKnown = Number.isFinite(Number(syncStatus.tronfireStandby?.databaseCount));
  const standbyDbAllReady = syncStatus.tronfireStandby?.allReady === true;
  const standbyReady = syncStatus.standbyReady === true && (!standbyDbStatusKnown || standbyDbAllReady);
  const promotionReady = syncStatus.promotionReady === true && (!standbyDbStatusKnown || standbyDbAllReady);
  const standbyLag = Number.isFinite(Number(syncStatus.standbyLagMinutes)) ? Number(syncStatus.standbyLagMinutes) : null;
  const latestBackupReceived = syncStatus.tronfireStandby?.latestBackupAt || syncStatus.receiver?.latestBackup?.modifiedAt || null;
  const latestRestoreValidated = syncStatus.tronfireStandby?.latestValidatedAt || null;
  const standbyDatabaseSummary = syncStatus.tronfireStandby?.databaseCount
    ? `${syncStatus.tronfireStandby.readyCount || 0}/${syncStatus.tronfireStandby.databaseCount}`
    : '-';
  const lockValues = lockForm || {
    cluster: lock.cluster || values.clusterId,
    active_node: lock.active_node || (values.nodeRole === 'primary' ? values.nodeName : ''),
    this_node: lock.this_node || values.nodeName,
    allow_promotion: lock.allow_promotion === true,
    last_valid_standby: lock.last_valid_standby || '',
    reason: lock.reason || ''
  };
  const failover = cluster.failover || {};
  const [failoverForm, setFailoverForm] = useState(null);
  const failoverValues = failoverForm || {
    enabled: failover.enabled !== false,
    timeoutSeconds: failover.timeoutSeconds || 60,
    checkIntervalSeconds: failover.checkIntervalSeconds || 5,
    primaryHealthUrl: failover.primaryHealthUrl || ''
  };
  const syncValues = syncForm || {
    enabled: true,
    standbyHost: sync.standbyHost || '',
    sshUser: sync.sshUser || 'tronsoft',
    sshPort: sync.sshPort || 22,
    autoEnabled: true,
    syncMode: sync.syncMode || 'physical',
    intervalMinutes: 3,
    remoteBackupDir: sync.remoteBackupDir || '/opt/tronfire-storage/firebird/backups',
    remoteCatalogDir: sync.remoteCatalogDir || '/tmp/tronfire-catalog',
    backupDir: sync.backupDir || '/opt/tronfire-storage/firebird/backups',
    catalogDir: sync.catalogDir || '/opt/tronsoftos/state/tronfire-catalog'
  };
  const vipValues = vipForm || {
    interfaceName: cluster.keepalived?.interface || networkImpact.current?.interface || 'eth0',
    vipCidr: cluster.vipCidr || (cluster.vip ? `${cluster.vip}/24` : ''),
    routerId: Number(cluster.keepalived?.routerId || 51),
    authPass: '',
    nodeState: cluster.keepalived?.nodeState || (values.nodeRole === 'primary' ? 'MASTER' : 'BACKUP'),
    priority: Number(cluster.keepalived?.priority || (values.nodeRole === 'primary' ? 150 : 100))
  };
  const saveMutation = useMutation({
    mutationFn: payload => fetch('/api/node-identity', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['node-identity'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const lockMutation = useMutation({
    mutationFn: payload => fetch('/api/cluster/lock', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setLockForm({
        cluster: data.cluster || '',
        active_node: data.active_node || '',
        this_node: data.this_node || '',
        allow_promotion: data.allow_promotion === true,
        last_valid_standby: data.last_valid_standby || '',
        reason: data.reason || ''
      });
      queryClient.invalidateQueries({ queryKey: ['cluster-lock'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
      queryClient.invalidateQueries({ queryKey: ['node-identity'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const blockMutation = useMutation({
    mutationFn: reason => postApi('/api/cluster/promotion/block', { reason }),
    onSuccess: data => {
      setLockForm({
        cluster: data.cluster || '',
        active_node: data.active_node || '',
        this_node: data.this_node || '',
        allow_promotion: data.allow_promotion === true,
        last_valid_standby: data.last_valid_standby || '',
        reason: data.reason || ''
      });
      queryClient.invalidateQueries({ queryKey: ['cluster-lock'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const activateMutation = useMutation({
    mutationFn: reason => postApi('/api/cluster/activate-local', { reason }),
    onSuccess: data => {
      if (data.lock) {
        setLockForm({
          cluster: data.lock.cluster || '',
          active_node: data.lock.active_node || '',
          this_node: data.lock.this_node || '',
          allow_promotion: data.lock.allow_promotion === true,
          last_valid_standby: data.lock.last_valid_standby || '',
          reason: data.lock.reason || ''
        });
      }
      queryClient.invalidateQueries({ queryKey: ['cluster-lock'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const recoveryMutation = useMutation({
    mutationFn: reason => postApi('/api/cluster/recovery-local', { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['node-identity'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-lock'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const syncMutation = useMutation({
    mutationFn: payload => fetch('/api/cluster/sync', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setSyncForm(data);
      queryClient.invalidateQueries({ queryKey: ['ha-sync-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const runSyncMutation = useMutation({
    mutationFn: () => postApi('/api/cluster/sync/run'),
    onSuccess: data => {
      setSyncJobId(data.job?.id || null);
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const syncJobQuery = useQuery({
    queryKey: ['ha-sync-job', syncJobId],
    queryFn: () => api(`/api/actions/${syncJobId}`),
    enabled: !!syncJobId,
    refetchInterval: query => query.state.data?.status === 'running' ? 1200 : false
  });
  const failoverMutation = useMutation({
    mutationFn: payload => fetch('/api/cluster/failover', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setFailoverForm(data);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const haLogsQuery = useQuery({
    queryKey: ['ha-sync-logs', selectedHaLog],
    queryFn: () => api(`/api/cluster/sync/logs${selectedHaLog ? `?file=${encodeURIComponent(selectedHaLog)}` : ''}`),
    refetchInterval: clusterTab === 'logs' ? 5000 : false
  });
  const vipMutation = useMutation({
    mutationFn: payload => postApi('/api/host/network/vip', payload),
    onSuccess: data => {
      setVipForm(previous => ({ ...(previous || vipValues), vipCidr: data.vipCidr || vipValues.vipCidr, authPass: '' }));
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-network-impact'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));
  const setLockValue = (key, value) => setLockForm(previous => ({ ...(previous || lockValues), [key]: value }));
  const setFailoverValue = (key, value) => setFailoverForm(previous => ({ ...(previous || failoverValues), [key]: value }));
  const setSyncValue = (key, value) => setSyncForm(previous => ({ ...(previous || syncValues), [key]: value }));
  const setVipValue = (key, value) => setVipForm(previous => ({ ...(previous || vipValues), [key]: value }));
  const canManageSync = values.deploymentMode !== 'ha' || guard.canServeProduction === true || values.nodeRole === 'primary';
  const canExportPairing = values.deploymentMode !== 'ha' || guard.canServeProduction === true || values.nodeRole === 'primary';
  const canImportPairing = values.deploymentMode === 'ha' && !canExportPairing && ['standby', 'recovery'].includes(values.nodeRole);
  const pairingImportMutation = useMutation({
    mutationFn: content => postApi('/api/cluster/pairing-file/import', { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['cluster-guard'] });
    }
  });
  const importPairingFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => pairingImportMutation.mutate(String(reader.result || ''));
    reader.readAsText(file);
    event.target.value = '';
  };
  const clusterTabs = [
    { id: 'overview', label: 'Visao geral', icon: Activity },
    { id: 'identity', label: 'Identidade', icon: ShieldCheck },
    { id: 'vip', label: 'VIP', icon: Network },
    { id: 'pairing', label: 'Pareamento', icon: UploadCloud },
    ...(canManageSync ? [{ id: 'sync', label: 'Sync', icon: RefreshCw }] : []),
    { id: 'logs', label: 'Logs HA', icon: Terminal },
    { id: 'promotion', label: 'Promocao', icon: GitBranch }
  ];
  return (
    <div className="space-y-5">
      <SubTabs items={clusterTabs} active={clusterTab} onChange={setClusterTab} />

      {clusterTab === 'overview' ? (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-4">
            <Stat label="No atual" value={cluster.nodeName} detail={identity.clusterId || 'cluster local'} icon={Server} tone="sky" />
            <Stat label="Papel" value={cluster.nodeRole} detail={guard.status || 'guard'} icon={ShieldCheck} tone={guard.canServeProduction ? 'green' : 'amber'} />
            <Stat label="VIP" value={cluster.vip || '-'} detail={cluster.keepalived?.enabled ? 'keepalived ativo' : 'nao configurado'} icon={Network} tone={cluster.keepalived?.enabled ? 'green' : 'amber'} />
            <Stat label="Promocao" value={guard.canPromote ? 'liberada' : 'bloqueada'} detail={guard.reason || 'cluster-lock'} icon={GitBranch} tone={guard.canPromote ? 'amber' : 'green'} />
          </div>
          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
            <Card title="Topologia HA" icon={Activity}><Topology dashboard={dashboard} /></Card>
            <Card title="Estado do cluster" icon={GitBranch}>
              <dl className="grid gap-3 text-sm">
                {[
                  ['Modo', cluster.mode],
                  ['No', cluster.nodeName],
                  ['Papel', cluster.nodeRole],
                  ['Cluster ID', identity.clusterId || '-'],
                  ['VIP', cluster.vip || 'nao configurado'],
                  ['Keepalived', cluster.keepalived?.enabled ? 'ativo' : 'nao configurado'],
                  ['Cluster lock', cluster.lock ? 'presente' : 'ausente'],
                  ['Guard', guard.status || '-']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-medium text-slate-950">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
          <div className="grid gap-5 xl:grid-cols-3">
            <Card title="Dono do VIP" icon={Network} action={<StatusPill value={vipCardStatus} />}>
              <div className="grid gap-3 text-sm">
                {[
                  ['VIP', vipStatus.vip || cluster.vip || 'nao configurado'],
                  ['Este no possui VIP', vipStatus.localPresent ? 'sim' : 'nao'],
                  ['Esperado neste no', vipLocalExpected],
                  ['Interface local', vipStatus.localInterface || '-'],
                  ['Health pelo VIP', vipStatus.reachable ? vipHolderLabel : 'sem resposta'],
                  ['Papel pelo VIP', vipHolder.nodeRole || '-']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-slate-500">{label}</span>
                    <span className="min-w-0 truncate text-right font-medium text-slate-950">{value}</span>
                  </div>
                ))}
              </div>
              {!vipStatus.vip ? (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  VIP ainda nao configurado para este cluster.
                </div>
              ) : vipStatus.ok ? (
                <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                  VIP coerente com o papel atual do no e respondendo como primary.
                </div>
              ) : vipStatus.reachable ? (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  O VIP respondeu, mas revise se o dono e o papel retornado estao corretos.
                </div>
              ) : (
                <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  O health pelo VIP nao respondeu. Verifique Keepalived, ARP e conectividade local.
                </div>
              )}
            </Card>
            <Card title="Sync HA" icon={RefreshCw} action={<StatusPill value={isSyncReceiver ? 'receptor' : (syncStatus.status || 'disabled')} />}>
              <div className="grid gap-3 text-sm">
                {(isSyncReceiver ? [
                  ['Status', 'receptor'],
                  ['Modo', 'recebe dados do primary'],
                  ['Catalogo recebido', syncStatus.receiver?.latestCatalog?.modifiedAt ? formatDateTime(syncStatus.receiver.latestCatalog.modifiedAt) : 'aguardando'],
                  ['Backup recebido', syncStatus.receiver?.latestBackup?.modifiedAt ? formatDateTime(syncStatus.receiver.latestBackup.modifiedAt) : 'aguardando'],
                  ['Diretorio catalogo', syncStatus.receiver?.catalogDir || '/opt/tronsoftos/state/tronfire-catalog'],
                  ['Diretorio backups', syncStatus.receiver?.backupDir || '/opt/tronfire-storage/firebird/backups']
                ] : [
                  ['Status', syncStatus.status || (syncStatus.enabled ? 'enabled' : 'disabled')],
                  ['Modo', syncStatus.syncMode === 'backup_restore' ? 'seguro backup/restore' : 'fisico rapido'],
                  ['Automatico', syncStatus.autoEnabled ? 'habilitado' : 'desativado'],
                  ['Intervalo', syncStatus.intervalMinutes ? `${syncStatus.intervalMinutes} min` : '-'],
                  ['Standby', syncStatus.standbyHost || 'nao configurado'],
                  ['Usuario SSH', syncStatus.sshUser || 'tronsoft'],
                  ['Ultimo sync', syncStatus.lastEvent?.createdAt ? formatDateTime(syncStatus.lastEvent.createdAt) : '-'],
                  ['Proximo sync', syncStatus.nextRunAt ? formatDateTime(syncStatus.nextRunAt) : '-'],
                  ['Defasagem', standbyLag === null ? '-' : `${standbyLag} min`],
                  ['Exit code', syncStatus.lastEvent?.exitCode ?? '-']
                ]).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-slate-500">{label}</span>
                    <span className="min-w-0 truncate text-right font-medium text-slate-950">{value}</span>
                  </div>
                ))}
              </div>
              {isSyncReceiver ? (
                <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${syncStatus.receiver?.latestCatalog ? 'border-green-200 bg-green-50 text-green-700' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>
                  {syncStatus.receiver?.latestCatalog ? 'Este standby ja recebeu catalogo do primary.' : 'Aguardando a primeira sincronizacao enviada pelo primary.'}
                </div>
              ) : syncStatus.status === 'failed' ? (
                <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  Ultima sincronizacao falhou. Verifique se o pareamento foi importado no standby e se o SSH para {syncStatus.sshUser || 'tronsoft'}@{syncStatus.standbyHost || 'standby'} esta autorizado.
                </div>
              ) : syncStatus.status === 'success' ? (
                <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                  Ultima sincronizacao concluida com sucesso.
                </div>
              ) : syncStatus.enabled ? (
                <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
                  Sync configurado. Use a aba Sync para executar uma sincronizacao manual.
                </div>
              ) : (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Sync HA ainda nao esta habilitado.
                </div>
              )}
            </Card>
            <Card title="Prontidao do standby" icon={ShieldCheck} action={<StatusPill value={standbyReady ? 'READY' : 'atrasado'} />}>
              <div className="grid gap-3 text-sm">
                {[
                  ['Status', standbyReady ? 'Standby READY' : 'Standby atrasado'],
                  ['Bancos prontos', standbyDatabaseSummary],
                  ['Ultimo backup recebido', latestBackupReceived ? formatDateTime(latestBackupReceived) : 'aguardando'],
                  ['Ultimo restore validado', latestRestoreValidated ? formatDateTime(latestRestoreValidated) : 'aguardando'],
                  ['Tempo de defasagem', standbyLag === null ? '-' : `${standbyLag} min`],
                  ['Apto para promocao', promotionReady ? 'sim' : 'nao']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-slate-500">{label}</span>
                    <span className="min-w-0 truncate text-right font-medium text-slate-950">{value}</span>
                  </div>
                ))}
              </div>
              <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${promotionReady ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                {promotionReady
                  ? 'Standby com restore validado dentro da janela configurada.'
                  : standbyDbStatusKnown && !standbyDbAllReady
                    ? 'Backup recebido, mas ainda falta restaurar e validar todos os bancos obrigatorios no standby.'
                    : 'Standby ainda nao deve ser promovido sem validar a defasagem e o ultimo backup recebido.'}
              </div>
            </Card>
            <Card title="Protecao de duplo primary" icon={ShieldCheck} action={<StatusPill value={guard.canHoldVip ? 'online' : 'blocked'} />}>
              <div className="grid gap-3 text-sm">
                {[
                  ['Status', guard.status || '-'],
                  ['Motivo', guard.reason || '-'],
                  ['No local', guard.thisNode || values.nodeName],
                  ['No ativo', guard.activeNode || 'nao definido'],
                  ['Pode segurar VIP', guard.canHoldVip ? 'sim' : 'nao'],
                  ['Pode servir producao', guard.canServeProduction ? 'sim' : 'nao'],
                  ['Pode promover', guard.canPromote ? 'sim' : 'nao']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-slate-500">{label}</span>
                    <span className="text-right font-medium text-slate-950">{value}</span>
                  </div>
                ))}
              </div>
              {guard.returnedFormerPrimary ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Este no parece ser um antigo principal retornando. Ele fica bloqueado para VIP/producao ate ressincronizar.</div> : null}
            </Card>
            <Card title="Impacto de rede HA" icon={Network} action={<StatusPill value={networkImpact.vipSameSubnet === false ? 'warning' : 'online'} />}>
              <div className="grid gap-3 text-sm">
                {[
                  ['Interface', networkImpact.current?.interface || '-'],
                  ['IP real atual', networkImpact.current?.cidr || '-'],
                  ['VIP', networkImpact.vip || 'nao configurado'],
                  ['VIP na mesma rede', networkImpact.vipSameSubnet === null || networkImpact.vipSameSubnet === undefined ? '-' : networkImpact.vipSameSubnet ? 'sim' : 'nao'],
                  ['Sync HA standby', networkImpact.sync?.standbyHost || 'nao configurado'],
                  ['Cloudflare destino', networkImpact.cloudflare?.targetIp || 'nao configurado']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                    <span className="text-slate-500">{label}</span>
                    <span className="text-right font-medium text-slate-950">{value}</span>
                  </div>
                ))}
              </div>
              {networkImpact.warnings?.length ? (
                <div className="mt-4 grid gap-2">
                  {networkImpact.warnings.map((item, index) => (
                    <div key={`${item.message}-${index}`} className={`rounded-md border px-3 py-2 text-sm ${item.level === 'danger' ? 'border-red-200 bg-red-50 text-red-700' : item.level === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>
                      {item.message}
                    </div>
                  ))}
                </div>
              ) : <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Nenhum impacto critico detectado para a configuracao atual.</div>}
            </Card>
          </div>
        </div>
      ) : null}

      {clusterTab === 'identity' ? (
        <Card title="Identidade do no" icon={ShieldCheck}>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={event => {
              event.preventDefault();
              saveMutation.mutate(values);
            }}
          >
            <Field label="Cluster ID" value={values.clusterId} onChange={value => setValue('clusterId', value)} placeholder="cliente-x" />
            <Field label="Nome do no" value={values.nodeName} onChange={value => setValue('nodeName', value)} placeholder="servidor-01" />
            <label className="block">
              <span className="text-xs font-medium uppercase text-slate-500">Modo</span>
              <select value={values.deploymentMode} onChange={event => setValue('deploymentMode', event.target.value)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
                <option value="simple">simple</option>
                <option value="ha">ha</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase text-slate-500">Papel</span>
              <select value={values.nodeRole} onChange={event => setValue('nodeRole', event.target.value)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
                <option value="primary">primary</option>
                <option value="standby">standby</option>
                <option value="recovery">recovery</option>
              </select>
            </label>
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <button disabled={saveMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                <Save className="h-4 w-4" />
                Salvar identidade
              </button>
              {saveMutation.isSuccess ? <span className="text-sm text-green-700">Identidade salva.</span> : null}
              {saveMutation.isError ? <span className="text-sm text-red-700">{saveMutation.error?.message}</span> : null}
            </div>
          </form>
        </Card>
      ) : null}

      {clusterTab === 'pairing' ? (
        <Card title="Pareamento HA" icon={ShieldCheck}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900">Arquivo do no principal</div>
              <div className="mt-1 text-sm text-slate-500">
                {canExportPairing ? 'Exporte deste no ativo para parear um standby.' : 'Importe no standby o arquivo exportado pelo no ativo.'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {canImportPairing ? (
                <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
                  <UploadCloud className="h-4 w-4" />
                  Importar arquivo
                  <input type="file" accept=".env,text/plain" className="hidden" onChange={importPairingFile} />
                </label>
              ) : null}
              {canExportPairing ? (
                <a href="/api/cluster/pairing-file" className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50">
                  <UploadCloud className="h-4 w-4" />
                  Exportar arquivo
                </a>
              ) : null}
            </div>
          </div>
          {!canExportPairing && !canImportPairing ? (
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Pareamento indisponivel para o estado atual do no.
            </div>
          ) : null}
          {pairingImportMutation.isSuccess ? (
            <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              <div className="font-medium">Pareamento importado com sucesso.</div>
              <div className="mt-1">
                Chave SSH do primary: {pairingImportMutation.data?.sshKeyImported ? 'importada no authorized_keys' : 'nao encontrada no arquivo importado'}.
              </div>
              <div className="mt-1">Reinicie TronSoftOS e TronFire para carregar os segredos no standby.</div>
              {pairingImportMutation.data?.paths?.authorizedKeys ? (
                <div className="mt-1 truncate font-mono text-xs">{pairingImportMutation.data.paths.authorizedKeys}</div>
              ) : null}
              {pairingImportMutation.data?.keepalived ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={vipMutation.isPending}
                    onClick={() => vipMutation.mutate({
                      interfaceName: vipValues.interfaceName,
                      vipCidr: pairingImportMutation.data.keepalived.vipCidr,
                      routerId: pairingImportMutation.data.keepalived.routerId,
                      authPass: '',
                      nodeState: values.nodeRole === 'primary' ? 'MASTER' : 'BACKUP',
                      priority: values.nodeRole === 'primary' ? 150 : 100
                    })}
                    className="inline-flex items-center justify-center gap-2 rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
                  >
                    <Network className="h-4 w-4" />
                    Aplicar VIP importado neste no
                  </button>
                  <span className="text-xs text-green-800">
                    Usa {pairingImportMutation.data.keepalived.vipCidr}, interface {vipValues.interfaceName} e prioridade {values.nodeRole === 'primary' ? 150 : 100}.
                  </span>
                </div>
              ) : null}
              {vipMutation.isSuccess ? <div className="mt-2 text-sm font-medium">VIP aplicado. Reinicie TronSoftOS para recarregar as variaveis do no.</div> : null}
              {vipMutation.isError ? <div className="mt-2 text-sm text-red-700">{vipMutation.error.message}</div> : null}
            </div>
          ) : null}
          {pairingImportMutation.isError ? (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {pairingImportMutation.error.message}
            </div>
          ) : null}
        </Card>
      ) : null}

      {clusterTab === 'vip' ? (
      <Card title="VIP Keepalived" icon={Network} action={<StatusPill value={cluster.keepalived?.enabled ? 'online' : 'disabled'} />}>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            vipMutation.mutate(vipValues);
          }}
        >
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 md:col-span-2">
            VIP/CIDR, Router ID e senha VRRP sao dados do cluster e acompanham o arquivo de pareamento exportado pelo primary. Interface e prioridade continuam sendo configuracao local deste no.
          </div>
          <Field label="VIP/CIDR do cluster" value={vipValues.vipCidr} onChange={value => setVipValue('vipCidr', value)} placeholder="192.168.1.200/24" />
          <Field label="Router ID do cluster" type="number" value={vipValues.routerId} onChange={value => setVipValue('routerId', Number(value || 51))} placeholder="51" />
          <Field label="Senha VRRP do cluster" type="password" value={vipValues.authPass} onChange={value => setVipValue('authPass', value)} placeholder="importada do primary ou 6 a 32 caracteres" />
          <Field label="Interface local" value={vipValues.interfaceName} onChange={value => setVipValue('interfaceName', value)} placeholder="eth0, ens18" />
          <label className="block">
            <span className="text-xs font-medium uppercase text-slate-500">Papel Keepalived</span>
            <select value={vipValues.nodeState} onChange={event => setVipValue('nodeState', event.target.value)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
              <option value="MASTER">MASTER</option>
              <option value="BACKUP">BACKUP</option>
            </select>
          </label>
          <Field label="Prioridade local" type="number" value={vipValues.priority} onChange={value => setVipValue('priority', Number(value || 100))} placeholder="primary 150, standby 100" />
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <button disabled={vipMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Aplicar VIP
            </button>
            {vipMutation.isSuccess ? <StatusPill value="online" /> : null}
            {vipMutation.isError ? <span className="text-sm text-red-700">{vipMutation.error.message}</span> : null}
          </div>
          {vipMutation.data?.reloadRequired ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 md:col-span-2">
              Keepalived atualizado. Reinicie TronSoftOS e apps gerenciados para recarregar variaveis sincronizadas.
            </div>
          ) : null}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 md:col-span-2">
            O primary normalmente usa prioridade 150 e o standby 100. Ajuste a interface local conforme o nome real da placa de rede neste host.
          </div>
        </form>
      </Card>
      ) : null}

      {clusterTab === 'logs' ? (
        <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
          <Card title="Logs do Sync HA" icon={Terminal} action={<StatusPill value={haLogsQuery.data?.selected?.status || 'logs'} />}>
            <div className="mb-3 text-xs text-slate-500">
              Diretorio: <span className="font-mono">{haLogsQuery.data?.logDir || '-'}</span>
            </div>
            <div className="grid max-h-[34rem] gap-2 overflow-auto pr-1">
              {(haLogsQuery.data?.files || []).map(file => {
                const selected = (haLogsQuery.data?.selected?.name || selectedHaLog) === file.name;
                return (
                  <button
                    key={file.name}
                    type="button"
                    onClick={() => setSelectedHaLog(file.name)}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${selected ? 'border-slate-900 bg-slate-950 text-white' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-xs">{file.name}</span>
                      <StatusPill value={file.status} />
                    </div>
                    <div className={`mt-1 text-xs ${selected ? 'text-slate-300' : 'text-slate-500'}`}>
                      {formatDateTime(file.modifiedAt)} · {formatBytes(file.size)}
                    </div>
                    {file.summary ? (
                      <pre className={`mt-2 max-h-16 overflow-hidden whitespace-pre-wrap text-xs ${selected ? 'text-slate-200' : 'text-slate-500'}`}>{file.summary}</pre>
                    ) : null}
                  </button>
                );
              })}
              {haLogsQuery.data && (haLogsQuery.data.files || []).length === 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Nenhum log de Sync HA encontrado ainda.
                </div>
              ) : null}
              {haLogsQuery.isError ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {haLogsQuery.error.message}
                </div>
              ) : null}
            </div>
          </Card>
          <Card title={haLogsQuery.data?.selected?.name || 'Conteudo do log'} icon={Terminal} action={<button type="button" onClick={() => haLogsQuery.refetch()} className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"><RefreshCw className="h-3.5 w-3.5" />Atualizar</button>}>
            <pre className="min-h-[34rem] max-h-[calc(100vh-18rem)] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
              {haLogsQuery.isLoading ? 'Carregando logs...' : (haLogsQuery.data?.content || 'Selecione um log para visualizar.')}
            </pre>
          </Card>
        </div>
      ) : null}

      {clusterTab === 'promotion' ? (
        <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Failover automatico" icon={RefreshCw} action={<StatusPill value={failoverValues.enabled ? 'automatico' : 'manual'} />}>
        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault();
            failoverMutation.mutate(failoverValues);
          }}
        >
          <Checkbox label="Promover standby automaticamente quando o primary cair" checked={failoverValues.enabled} onChange={value => setFailoverValue('enabled', value)} />
          <Field label="Health real do primary" value={failoverValues.primaryHealthUrl} onChange={value => setFailoverValue('primaryHealthUrl', value)} placeholder="http://192.168.1.10:8080/health" />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Tempo para assumir" type="number" value={failoverValues.timeoutSeconds} onChange={value => setFailoverValue('timeoutSeconds', Number(value || 60))} placeholder="60" />
            <Field label="Intervalo de checagem" type="number" value={failoverValues.checkIntervalSeconds} onChange={value => setFailoverValue('checkIntervalSeconds', Number(value || 5))} placeholder="5" />
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {failover.primaryDownSince
              ? `Primary indisponivel ha ${failover.elapsedSeconds || 0}s. ${failover.enabled ? `Promocao automatica em ${failover.remainingSeconds ?? 0}s se o standby estiver READY.` : 'Modo manual: nenhuma promocao automatica sera executada.'}`
              : failover.watchdogActive
                ? 'Watchdog ativo no standby. Aguardando queda do primary.'
                : 'Watchdog ativo somente em no standby HA.'}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button disabled={failoverMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar failover
            </button>
            {failoverMutation.isSuccess ? <StatusPill value="online" /> : null}
            {failoverMutation.isError ? <span className="text-sm text-red-700">{failoverMutation.error.message}</span> : null}
          </div>
        </form>
      </Card>
      <Card title="Controle de promocao" icon={ShieldCheck} action={<StatusPill value={lockValues.allow_promotion ? 'warning' : 'disabled'} />}>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            lockMutation.mutate(lockValues);
          }}
        >
          <Field label="Cluster" value={lockValues.cluster} readOnly placeholder="cliente-x" />
          <Field label="No atual" value={lockValues.this_node} readOnly placeholder="servidor-02" />
          <Field label="No ativo" value={lockValues.active_node} readOnly placeholder="servidor-01" />
          <Field label="Ultimo standby valido" value={lockValues.last_valid_standby} onChange={value => setLockValue('last_valid_standby', value)} placeholder="2026-05-28 10:30" />
          <label className="block md:col-span-2">
            <span className="text-xs font-medium uppercase text-slate-500">Motivo/confirmacao</span>
            <textarea value={lockValues.reason} onChange={event => setLockValue('reason', event.target.value)} className="mt-1 h-20 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" placeholder="Ex: primary parado para manutencao, standby validado" />
          </label>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <button type="button" disabled={lockMutation.isPending} onClick={() => lockMutation.mutate({ ...lockValues, allow_promotion: true })} className="inline-flex items-center justify-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
              <ShieldCheck className="h-4 w-4" />
              Permitir promocao
            </button>
            <button type="button" disabled={blockMutation.isPending} onClick={() => blockMutation.mutate(lockValues.reason || 'promocao bloqueada pelo TronSoftOS')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <XCircle className="h-4 w-4" />
              Bloquear promocao
            </button>
            <button disabled={lockMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar trava
            </button>
          </div>
          {lockMutation.isSuccess || blockMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Cluster-lock atualizado.</div> : null}
          {lockMutation.isError || blockMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-2">{lockMutation.error?.message || blockMutation.error?.message}</div> : null}
        </form>
      </Card>
      <Card title="Protecao de duplo primary" icon={ShieldCheck} action={<StatusPill value={guard.canHoldVip ? 'online' : 'blocked'} />}>
        <div className="grid gap-3 text-sm">
          {[
            ['Status', guard.status || '-'],
            ['Motivo', guard.reason || '-'],
            ['No local', guard.thisNode || values.nodeName],
            ['No ativo', guard.activeNode || 'nao definido'],
            ['Pode segurar VIP', guard.canHoldVip ? 'sim' : 'nao'],
            ['Pode servir producao', guard.canServeProduction ? 'sim' : 'nao'],
            ['Pode promover', guard.canPromote ? 'sim' : 'nao']
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
              <span className="text-slate-500">{label}</span>
              <span className="text-right font-medium text-slate-950">{value}</span>
            </div>
          ))}
        </div>
        {guard.returnedFormerPrimary ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Este nó parece ser um antigo principal retornando. Ele fica bloqueado para VIP/producao ate ressincronizar.</div> : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={activateMutation.isPending || (!guard.canPromote && values.deploymentMode === 'ha' && values.nodeRole === 'standby')} onClick={() => activateMutation.mutate(lockValues.reason || 'ativacao manual confirmada no TronSoftOS')} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" />
            Promover e ativar este no
          </button>
          <button type="button" disabled={recoveryMutation.isPending} onClick={() => recoveryMutation.mutate(lockValues.reason || 'nó retornou e sera ressincronizado antes de voltar ao cluster')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
            <XCircle className="h-4 w-4" />
            Colocar em recuperacao
          </button>
        </div>
        {activateMutation.isSuccess || recoveryMutation.isSuccess ? <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Protecao atualizada.</div> : null}
        {activateMutation.isError || recoveryMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{activateMutation.error?.message || recoveryMutation.error?.message}</div> : null}
      </Card>
        </div>
      ) : null}

      {clusterTab === 'sync' ? (
        canManageSync ? (
      <Card title="Sync HA" icon={RefreshCw} action={<StatusPill value={sync.sshValidated ? 'automatico' : syncValues.standbyHost ? 'SSH pendente' : 'configurar'} />}>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            syncMutation.mutate({ ...syncValues, enabled: true, autoEnabled: true });
          }}
        >
          <div className="md:col-span-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3 md:grid-cols-[1fr_220px]">
              <div>
                <div className="text-sm font-medium text-slate-950">{sync.sshValidated ? 'Sincronizacao automatica ativa' : 'Sincronizacao aguardando validacao SSH'}</div>
                <div className="mt-1 text-xs text-slate-500">
                  O modo fisico rapido usa nbackup + rsync pela rede de sync a cada 3 minutos. O modo seguro usa backup validado + restore no standby.
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                <div className="text-xs font-medium uppercase text-slate-500">Intervalo</div>
                <div className="mt-1 font-semibold text-slate-950">3 minutos</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              {sync.sshValidated
                ? 'O automatico roda somente no primary/ativo e nao inicia outro sync se ja houver um job em execucao. Esse ciclo continuo mantem o standby pronto para failover.'
                : 'Importe o pareamento no standby. O TronSoftOS testa a chave automaticamente e libera o agendamento assim que o acesso SSH for aceito.'}
            </div>
          </div>
          <label className="block">
            <span className="text-xs font-medium uppercase text-slate-500">Modo de sincronismo</span>
            <select
              value={syncValues.syncMode}
              onChange={event => setSyncValue('syncMode', event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            >
              <option value="physical">Fisico rapido: nbackup + rsync</option>
              <option value="backup_restore">Seguro: backup validado + restore</option>
            </select>
          </label>
          <Field label="Host/IP standby na rede de sync" value={syncValues.standbyHost} onChange={value => setSyncValue('standbyHost', value)} placeholder="10.0.0.2" />
          <Field label="Usuario SSH" value={syncValues.sshUser} onChange={value => setSyncValue('sshUser', value)} placeholder="tronsoft" />
          <Field label="Porta SSH" type="number" value={syncValues.sshPort} onChange={value => setSyncValue('sshPort', Number(value || 22))} placeholder="22" />
          <Field label="Backups locais" value={syncValues.backupDir} onChange={value => setSyncValue('backupDir', value)} placeholder="/opt/tronfire-storage/firebird/backups" />
          <Field label="Destino backups standby" value={syncValues.remoteBackupDir} onChange={value => setSyncValue('remoteBackupDir', value)} placeholder="/opt/tronfire-storage/firebird/backups" />
          <Field label="Catalogo local" value={syncValues.catalogDir} onChange={value => setSyncValue('catalogDir', value)} placeholder="/opt/tronsoftos/state/tronfire-catalog" />
          <Field label="Destino catalogo standby" value={syncValues.remoteCatalogDir} onChange={value => setSyncValue('remoteCatalogDir', value)} placeholder="/tmp/tronfire-catalog" />
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <button disabled={syncMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar sync
            </button>
            <button type="button" disabled={runSyncMutation.isPending || syncJobQuery.data?.status === 'running' || sync.sshValidated !== true} onClick={() => runSyncMutation.mutate()} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw className="h-4 w-4" />
              Sincronizar agora
            </button>
            <StatusPill value={sync.sshValidated ? 'SSH validado' : 'SSH pendente'} />
          </div>
          {syncMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Configuracao de sync salva.</div> : null}
          {runSyncMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Sync iniciado.</div> : null}
          {syncMutation.isError || runSyncMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-2">{syncMutation.error?.message || runSyncMutation.error?.message}</div> : null}
        </form>
        {syncJobQuery.data ? <InlineTerminal job={syncJobQuery.data} /> : null}
      </Card>
        ) : (
          <Card title="Sync HA" icon={RefreshCw} action={<StatusPill value="disabled" />}>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Sync HA deve ser configurado e executado somente no no primary/ativo. Este no nao esta autorizado a enviar dados para standby.
            </div>
          </Card>
        )
      ) : null}
    </div>
  );
}

function BackupsView({ dashboard }) {
  const queryClient = useQueryClient();
  const rcloneQuery = useQuery({ queryKey: ['rclone-settings'], queryFn: () => api('/api/backups/rclone') });
  const files = dashboard.backups.recentFiles || [];
  const rclone = rcloneQuery.data || dashboard.backups.rclone || {};
  const remoteBackupsQuery = useQuery({ queryKey: ['rclone-remote-backups'], queryFn: () => api('/api/backups/rclone/remote-files'), enabled: !!(rclone.remote && rclone.configConfigured), staleTime: 30000 });
  const quota = dashboard.backups.quota;
  const remoteFiles = remoteBackupsQuery.data?.files || [];
  const [downloadJobId, setDownloadJobId] = useState(null);
  const [form, setForm] = useState(null);
  const values = form || {
    enabled: rclone.enabled || false,
    bin: rclone.bin || '/usr/bin/rclone',
    config: rclone.config || '/opt/tronsoftos/config/rclone/rclone.conf',
    remote: rclone.remote || 'gdrive',
    path: rclone.path || 'tronsoftos/backups',
    uploadOnlyRole: rclone.uploadOnlyRole || 'primary',
    configContent: ''
  };
  const saveMutation = useMutation({
    mutationFn: payload => fetch('/api/backups/rclone', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setForm({ ...data, configContent: '' });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['rclone-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const testMutation = useMutation({ mutationFn: () => postApi('/api/backups/rclone/test') });
  const uploadTestMutation = useMutation({ mutationFn: () => postApi('/api/backups/rclone/upload-test') });
  const downloadMutation = useMutation({
    mutationFn: remotePath => postApi('/api/backups/rclone/download', { path: remotePath }),
    onSuccess: data => {
      setDownloadJobId(data.job?.id || null);
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const downloadJobQuery = useQuery({
    queryKey: ['rclone-download-job', downloadJobId],
    queryFn: () => api(`/api/actions/${downloadJobId}`),
    enabled: !!downloadJobId,
    refetchInterval: query => query.state.data?.status === 'running' ? 1200 : false
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
      <Card title="Google Drive / Rclone" icon={UploadCloud} action={<StatusPill value={rclone.configConfigured ? 'online' : 'warning'} />} className="xl:col-span-2">
        <div className={`mb-4 rounded-md border px-3 py-3 text-sm ${quota?.ok === false ? 'border-amber-200 bg-amber-50 text-amber-800' : quota?.percentUsed >= 90 ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-900">Espaco no Google Drive</div>
              <div className="text-xs">{quota?.ok === false ? quota.error : quota ? `${formatBytes(quota.used)} usados de ${formatBytes(quota.total)} (${quota.percentUsed ?? '-'}%)` : 'Quota ainda nao consultada'}</div>
            </div>
            {quota?.percentUsed !== null && quota?.percentUsed !== undefined ? <StatusPill value={quota.percentUsed >= 90 ? 'warning' : 'online'} /> : null}
          </div>
          {quota?.free ? <div className="mt-2 text-xs">Livre: {formatBytes(quota.free)}</div> : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={event => {
              event.preventDefault();
              saveMutation.mutate(values);
            }}
          >
            <div className="md:col-span-2">
              <Checkbox label="Habilitar upload externo" checked={values.enabled} onChange={value => setValue('enabled', value)} />
            </div>
            <Field label="Remote" value={values.remote} onChange={value => setValue('remote', value)} placeholder="gdrive" />
            <Field label="Pasta destino" value={values.path} onChange={value => setValue('path', value)} placeholder="tronsoftos/cliente-x" />
            <Field label="Binario rclone" value={values.bin} onChange={value => setValue('bin', value)} placeholder="/usr/bin/rclone" />
            <Field label="Arquivo rclone.conf" value={values.config} onChange={value => setValue('config', value)} placeholder="/opt/tronsoftos/config/rclone/rclone.conf" />
            <label className="block md:col-span-2">
              <span className="text-xs font-medium uppercase text-slate-500">Upload permitido no papel</span>
              <select value={values.uploadOnlyRole} onChange={event => setValue('uploadOnlyRole', event.target.value)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
                <option value="primary">primary</option>
                <option value="standby">standby</option>
                <option value="recovery">recovery</option>
                <option value="any">any</option>
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className="text-xs font-medium uppercase text-slate-500">Conteudo do rclone.conf</span>
              <textarea
                value={values.configContent}
                onChange={event => setValue('configContent', event.target.value)}
                placeholder="[gdrive]\ntype = drive\n..."
                className="mt-1 h-32 w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <button disabled={saveMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                <Save className="h-4 w-4" />
                Salvar rclone
              </button>
              <button type="button" disabled={testMutation.isPending} onClick={() => testMutation.mutate()} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" />
                Testar conexao
              </button>
              <button type="button" disabled={uploadTestMutation.isPending} onClick={() => uploadTestMutation.mutate()} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                <UploadCloud className="h-4 w-4" />
                Upload teste
              </button>
            </div>
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 md:col-span-2">
              Em HA, mantenha upload permitido no papel primary. Quando o standby for promovido, ele passa a enviar os backups.
            </div>
            {saveMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Configuracao salva.</div> : null}
            {testMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Conexao com {testMutation.data.remote || rclone.remote} OK. Destino configurado: {testMutation.data.target}</div> : null}
            {uploadTestMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Upload OK: {uploadTestMutation.data.target}</div> : null}
            {saveMutation.isError || testMutation.isError || uploadTestMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-2">{saveMutation.error?.message || testMutation.error?.message || uploadTestMutation.error?.message}</div> : null}
          </form>
          <aside className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <div className="mb-2 font-semibold text-slate-900">Como gerar o rclone.conf</div>
            <ol className="space-y-2 pl-5 text-sm leading-5 list-decimal">
              <li>Baixe o rclone em <a className="font-medium text-sky-700 hover:underline" href="https://rclone.org/downloads/" target="_blank" rel="noreferrer">rclone.org/downloads</a>.</li>
              <li>No Windows, extraia o ZIP em uma pasta simples, por exemplo <code className="rounded bg-white px-1 py-0.5 text-xs">C:\rclone</code>.</li>
              <li>Abra o Prompt de Comando nessa pasta e execute <code className="rounded bg-white px-1 py-0.5 text-xs">rclone config</code>.</li>
              <li>No menu, digite <code className="rounded bg-white px-1 py-0.5 text-xs">n</code> para criar um remote e informe um nome, por exemplo <code className="rounded bg-white px-1 py-0.5 text-xs">gdrive</code>.</li>
              <li>Escolha <code className="rounded bg-white px-1 py-0.5 text-xs">Google Drive</code>, deixe client_id e client_secret vazios e aceite a configuracao automatica.</li>
              <li>Quando o navegador abrir, entre na conta Google, autorize o acesso, confirme com <code className="rounded bg-white px-1 py-0.5 text-xs">y</code> e saia com <code className="rounded bg-white px-1 py-0.5 text-xs">q</code>.</li>
              <li>Ao finalizar, abra o arquivo <code className="rounded bg-white px-1 py-0.5 text-xs">%APPDATA%\rclone\rclone.conf</code> e cole o conteudo no campo ao lado.</li>
              <li>Salve, teste a conexao e rode um upload teste antes de habilitar em producao.</li>
            </ol>
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Por enquanto a integracao usa o rclone.conf colado manualmente. A tela de OAuth/credenciais Google foi removida ate definirmos se ficara no rclone ou em um worker de autorizacao.
            </div>
          </aside>
        </div>
      </Card>
      <Card title="Backups no Google Drive" icon={Cloud} action={<StatusPill value={remoteBackupsQuery.isError ? 'warning' : rclone.configConfigured ? 'online' : 'disabled'} />} className="xl:col-span-2">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <div>
            <div className="font-medium text-slate-900">{remoteBackupsQuery.data?.target || 'remote nao configurado'}</div>
            <div className="text-xs text-slate-500">Plano B: listar backups remotos do primary para baixar e restaurar manualmente no standby.</div>
          </div>
          <button
            type="button"
            disabled={remoteBackupsQuery.isFetching || !rclone.configConfigured}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['rclone-remote-backups'] })}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            Atualizar
          </button>
        </div>
        <div className="overflow-hidden rounded-md border border-slate-200">
          {remoteFiles.length ? remoteFiles.slice(0, 30).map(file => (
            <div key={file.path} className="grid grid-cols-[1fr_100px_170px_110px] items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-0">
              <span className="truncate font-medium" title={file.path}>{file.path}</span>
              <span className="text-right text-slate-500">{formatBytes(file.size)}</span>
              <span className="text-right text-slate-500">{file.modifiedAt ? new Date(file.modifiedAt).toLocaleString() : '-'}</span>
              <button
                type="button"
                disabled={downloadMutation.isPending || file.path.endsWith('.manifest.json')}
                onClick={() => downloadMutation.mutate(file.path)}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                <HardDrive className="h-3.5 w-3.5" />
                Baixar
              </button>
            </div>
          )) : <div className="px-3 py-8 text-center text-sm text-slate-500">{remoteBackupsQuery.isError ? remoteBackupsQuery.error.message : 'Nenhum backup remoto encontrado'}</div>}
        </div>
        {downloadMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{downloadMutation.error.message}</div> : null}
        {downloadJobQuery.data ? <div className="mt-4"><InlineTerminal job={downloadJobQuery.data} /></div> : null}
      </Card>
      <Card title="Arquivos recentes" icon={FileClock}>
        <div className="overflow-hidden rounded-md border border-slate-200">
          {files.length ? files.map(file => (
            <div key={file.path} className="grid grid-cols-[1fr_100px_170px] gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-0">
              <span className="truncate font-medium">{file.name}</span>
              <span className="text-right text-slate-500">{Math.round(file.size / 1024)} KB</span>
              <span className="text-right text-slate-500">{new Date(file.modifiedAt).toLocaleString()}</span>
            </div>
          )) : <div className="px-3 py-8 text-center text-sm text-slate-500">Nenhum backup encontrado</div>}
        </div>
      </Card>
    </div>
  );
}

function CloudflareView({ dashboard }) {
  const queryClient = useQueryClient();
  const cloudflareQuery = useQuery({ queryKey: ['cloudflare-settings'], queryFn: () => api('/api/cloudflare') });
  const cloudflare = cloudflareQuery.data || dashboard.cloudflare || {};
  const [form, setForm] = useState(null);
  const values = form || {
    enabled: cloudflare.enabled || false,
    apiToken: '',
    zoneId: cloudflare.zoneId || '',
    recordId: cloudflare.recordId || '',
    recordName: cloudflare.recordName || '',
    recordType: cloudflare.recordType || 'A',
    targetIp: cloudflare.targetIp || '',
    proxied: cloudflare.proxied !== false,
    ttl: cloudflare.ttl || 60
  };
  const saveMutation = useMutation({
    mutationFn: payload => fetch('/api/cloudflare', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setForm({ ...data, apiToken: '' });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const testMutation = useMutation({ mutationFn: () => postApi('/api/cloudflare/test') });
  const syncMutation = useMutation({
    mutationFn: () => postApi('/api/cloudflare/sync'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));
  return (
    <div className="max-w-5xl">
      <Card title="Cloudflare" icon={Cloud} action={<StatusPill value={cloudflare.tokenConfigured ? 'online' : 'warning'} />}>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            saveMutation.mutate(values);
          }}
        >
          <div className="md:col-span-2">
            <Checkbox label="Habilitar gerenciamento DNS" checked={values.enabled} onChange={value => setValue('enabled', value)} />
          </div>
          <Field label="API Token" type="password" value={values.apiToken} onChange={value => setValue('apiToken', value)} placeholder={cloudflare.tokenConfigured ? 'token ja configurado' : 'token Cloudflare'} />
          <Field label="Zone ID" value={values.zoneId} onChange={value => setValue('zoneId', value)} placeholder="zone id" />
          <Field label="Record ID" value={values.recordId} onChange={value => setValue('recordId', value)} placeholder="opcional" />
          <Field label="Registro" value={values.recordName} onChange={value => setValue('recordName', value)} placeholder="cliente.tronsoft.app.br" />
          <label className="block">
            <span className="text-xs font-medium uppercase text-slate-500">Tipo</span>
            <select value={values.recordType} onChange={event => setValue('recordType', event.target.value)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
              <option value="A">A</option>
              <option value="AAAA">AAAA</option>
              <option value="CNAME">CNAME</option>
            </select>
          </label>
          <Field label="Destino" value={values.targetIp} onChange={value => setValue('targetIp', value)} placeholder="IP, VIP ou hostname" />
          <Field label="TTL" type="number" value={values.ttl} onChange={value => setValue('ttl', Number(value))} placeholder="60" />
          <div className="flex items-end">
            <Checkbox label="Proxy Cloudflare" checked={values.proxied} onChange={value => setValue('proxied', value)} />
          </div>
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            <button disabled={saveMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar
            </button>
            <button type="button" disabled={testMutation.isPending} onClick={() => testMutation.mutate()} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw className="h-4 w-4" />
              Testar token
            </button>
            <button type="button" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <Zap className="h-4 w-4" />
              Sincronizar DNS
            </button>
          </div>
          {saveMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Configuracao salva.</div> : null}
          {testMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Token OK: {testMutation.data.zone}</div> : null}
          {syncMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">DNS sincronizado.</div> : null}
          {saveMutation.isError || testMutation.isError || syncMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-2">{saveMutation.error?.message || testMutation.error?.message || syncMutation.error?.message}</div> : null}
        </form>
      </Card>
    </div>
  );
}

function UpdatesView({ dashboard }) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState(null);
  const updateMutation = useMutation({
    mutationFn: payload => postApi('/api/maintenance/update', payload),
    onSuccess: data => {
      setJobId(data.job?.id || null);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const jobQuery = useQuery({
    queryKey: ['update-job', jobId],
    queryFn: () => api(`/api/actions/${jobId}`),
    enabled: !!jobId,
    refetchInterval: query => query.state.data?.status === 'running' ? 1200 : false
  });
  const build = dashboard.build || dashboard.cluster?.build || {};
  const role = dashboard.cluster?.nodeRole || dashboard.cluster?.identity?.nodeRole || '-';
  const mode = dashboard.cluster?.mode || '-';
  const standbyHost = dashboard.cluster?.sync?.standbyHost || '';
  const maintenanceBlock = dashboard.cluster?.failover?.maintenanceBlock || {};
  const busy = updateMutation.isPending || jobQuery.data?.status === 'running';
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="Versao atual" value={build.version || '-'} detail={build.buildNumber ? `Build ${build.buildNumber}` : 'build nao informado'} icon={GitBranch} tone="slate" />
        <Stat label="Branch atual" value={build.branch || '-'} detail={build.installedAt ? `instalado ${formatDateTime(build.installedAt)}` : 'instalacao nao informada'} icon={GitBranch} tone="sky" />
        <Stat label="Papel local" value={role} detail={mode} icon={ShieldCheck} tone={role === 'primary' ? 'green' : 'sky'} />
        <Stat label="Standby HA" value={standbyHost || '-'} detail={standbyHost ? 'sera bloqueado ao atualizar primary' : 'nao configurado'} icon={Server} tone={standbyHost ? 'green' : 'amber'} />
      </div>

      {jobQuery.data ? <ActionTerminal job={jobQuery.data} /> : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Atualizar branch dev" icon={RefreshCw} action={<StatusPill value={busy ? 'running' : 'dev'} />}>
          <div className="space-y-3 text-sm text-slate-700">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
              Em HA, atualize primeiro o standby. Ao atualizar o primary, o TronSoftOS bloqueia a promocao automatica no standby por manutencao planejada e libera novamente ao concluir.
            </div>
            <ol className="space-y-2">
              {[
                'Entrar em manutencao local',
                'Bloquear promocao automatica no standby quando este no for primary',
                'Baixar e aplicar a branch dev',
                'Executar install.sh e migrations do TronFire',
                'Liberar o standby e reiniciar o servico TronSoftOS'
              ].map(item => (
                <li key={item} className="flex items-center gap-2"><span className="status-dot bg-slate-300" />{item}</li>
              ))}
            </ol>
            <ConfirmAction
              label="Atualizar para dev"
              icon={RefreshCw}
              confirmation="ATUALIZAR DEV"
              tone="amber"
              disabled={busy}
              onConfirm={({ confirmation }) => updateMutation.mutate({ confirmation, branch: 'dev', timeoutMinutes: 30 })}
            />
            {updateMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{updateMutation.error.message}</div> : null}
          </div>
        </Card>
        <Card title="Trava de failover" icon={ShieldCheck} action={<StatusPill value={maintenanceBlock.active ? (maintenanceBlock.expired ? 'critical' : 'warning') : 'disabled'} />}>
          <div className="grid gap-3 text-sm">
            {[
              ['Status', maintenanceBlock.active ? 'ativo' : 'inativo'],
              ['Motivo', maintenanceBlock.reason || '-'],
              ['Inicio', maintenanceBlock.startedAt ? formatDateTime(maintenanceBlock.startedAt) : '-'],
              ['Limite', maintenanceBlock.expiresAt ? formatDateTime(maintenanceBlock.expiresAt) : '-'],
              ['Restante', maintenanceBlock.active && maintenanceBlock.remainingSeconds !== null ? `${maintenanceBlock.remainingSeconds}s` : '-']
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{label}</span>
                <span className="text-right font-medium text-slate-950">{value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Se o prazo vencer, o standby continua sem promover automaticamente e gera alerta critico para decisao manual do tecnico.
          </div>
        </Card>
      </div>
      <Card title="Ordem recomendada em HA" icon={Database}>
        <div className="grid gap-3 text-sm text-slate-700 md:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="font-semibold text-slate-950">1. Standby</div>
            <div>Atualize o standby primeiro e confirme que voltou online na mesma branch/build.</div>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="font-semibold text-slate-950">2. Primary</div>
            <div>Atualize o primary depois. O standby recebe trava temporaria de failover durante a manutencao.</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function EventsView() {
  const eventsQuery = useQuery({ queryKey: ['events'], queryFn: () => api('/api/events'), refetchInterval: 10000 });
  const events = eventsQuery.data?.events || [];
  return (
    <Card title="Eventos" icon={Terminal}>
      <div className="max-h-[520px] overflow-auto rounded-md bg-panel-950 p-3 font-mono text-xs text-slate-200 scrollbar-thin">
        {events.length ? events.map(event => (
          <div key={event.id} className="border-b border-white/10 py-2 last:border-0">
            <span className="text-sky-300">{event.createdAt}</span> <span className="text-green-300">{event.type}</span> {JSON.stringify(event.details)}
          </div>
        )) : <div className="py-8 text-center text-slate-400">Sem eventos registrados</div>}
      </div>
    </Card>
  );
}

function ConfirmAction({ label, icon: Icon, confirmation, tone = 'slate', disabled, onConfirm }) {
  const [value, setValue] = useState('');
  const ready = value.trim() === confirmation;
  const buttonClass = tone === 'red'
    ? 'bg-red-600 text-white hover:bg-red-700'
    : tone === 'amber'
      ? 'bg-amber-600 text-white hover:bg-amber-700'
      : 'bg-slate-950 text-white hover:bg-slate-800';
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-xs font-medium uppercase text-slate-500">Confirmacao exigida</div>
      <Field label={`Digite ${confirmation}`} value={value} onChange={setValue} placeholder={confirmation} />
      <button
        type="button"
        disabled={disabled || !ready}
        onClick={() => {
          onConfirm({ confirmation });
          setValue('');
        }}
        className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${buttonClass}`}
      >
        {Icon ? <Icon className="h-4 w-4" /> : null}
        {label}
      </button>
    </div>
  );
}

function StrategyOption({ option, selected, onSelect }) {
  const tone = option.dangerous ? 'border-red-200 bg-red-50' : option.recommended ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition hover:border-slate-300 ${selected ? 'ring-2 ring-slate-900' : ''} ${tone}`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-4 w-4 rounded-full border ${selected ? 'border-slate-950 bg-slate-950' : 'border-slate-300 bg-white'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-950">{option.label}</span>
            {option.recommended ? <StatusPill value="online" /> : null}
            {option.dangerous ? <StatusPill value="critical" /> : null}
          </span>
          <span className="mt-1 block text-sm text-slate-600">{option.description}</span>
        </span>
      </div>
    </button>
  );
}

function FailbackAssistant({ dashboard, onPrepared }) {
  const queryClient = useQueryClient();
  const failbackQuery = useQuery({ queryKey: ['maintenance-failback'], queryFn: () => api('/api/maintenance/failback'), refetchInterval: 8000 });
  const data = failbackQuery.data || {};
  const cluster = data.cluster || dashboard.cluster || {};
  const vipStatus = cluster.vipStatus || {};
  const holder = vipStatus.holder || {};
  const strategies = data.strategies || [];
  const localAddress = data.local?.address || '';
  const remoteAddress = data.remote?.address || '';
  const [form, setForm] = useState(null);
  const values = form || {
    desiredPrimaryHost: localAddress || '',
    desiredStandbyHost: remoteAddress || '',
    strategy: 'sync_from_active',
    confirmation: ''
  };
  const selectedStrategy = strategies.find(item => item.id === values.strategy) || strategies[0] || {};
  const expectedConfirmation = values.strategy === 'force_selected_database' ? 'USAR BANCO DO SERVIDOR ESCOLHIDO' : 'PREPARAR FAILBACK';
  const confirmationReady = values.confirmation.trim() === expectedConfirmation;
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));
  const mutation = useMutation({
    mutationFn: payload => postApi('/api/maintenance/failback/prepare', payload),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['maintenance-failback'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      onPrepared?.(result);
    }
  });
  const maintenanceFailback = data.maintenance?.mode === 'failback' && data.maintenance?.active ? data.maintenance.failback : null;

  return (
    <div className="space-y-5">
      <Card title="Diagnostico do failback" icon={ShieldCheck} action={<StatusPill value={vipStatus.ok ? 'online' : vipStatus.reachable ? 'warning' : 'offline'} />}>
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="grid gap-3 text-sm">
            {[
              ['VIP', vipStatus.vip || cluster.vip || 'nao configurado'],
              ['Respondendo por', holder.nodeName ? `${holder.nodeName} / ${holder.nodeRole || '-'}` : vipStatus.reachable ? 'no sem nome' : 'sem resposta'],
              ['Este no possui VIP', vipStatus.localPresent ? 'sim' : 'nao'],
              ['No local', `${data.local?.nodeName || cluster.nodeName || '-'} / ${data.local?.nodeRole || cluster.nodeRole || '-'}`],
              ['IP local', data.local?.cidr || '-'],
              ['No remoto configurado', remoteAddress || 'nao configurado']
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{label}</span>
                <span className="min-w-0 truncate text-right font-medium text-slate-950">{value}</span>
              </div>
            ))}
          </div>
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            O no que responde pelo VIP agora deve ser tratado como fonte da verdade por padrao. Se o banco for preparado manualmente, a producao permanece bloqueada ate a validacao final.
          </div>
        </div>
      </Card>

      <Card title="Topologia desejada" icon={GitBranch}>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            mutation.mutate(values);
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Primary desejado" value={values.desiredPrimaryHost} onChange={value => setValue('desiredPrimaryHost', value)} placeholder="192.168.1.154" />
            <Field label="Standby desejado" value={values.desiredStandbyHost} onChange={value => setValue('desiredStandbyHost', value)} placeholder="192.168.1.149" />
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase text-slate-500">Estrategia do banco</div>
            <div className="grid gap-3">
              {strategies.map(option => (
                <StrategyOption
                  key={option.id}
                  option={option}
                  selected={values.strategy === option.id}
                  onSelect={() => setForm(previous => ({ ...(previous || values), strategy: option.id, confirmation: '' }))}
                />
              ))}
            </div>
          </div>
          {selectedStrategy.productionLocked !== false ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Esta estrategia prepara o failback em modo protegido. O VIP/producao so deve ser liberado depois da validacao objetiva do banco e dos servicos.
            </div>
          ) : (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Estrategia avancada: se o outro no recebeu lancamentos enquanto estava ativo, pode haver perda de dados.
            </div>
          )}
          <Field label={`Confirmacao: digite ${expectedConfirmation}`} value={values.confirmation} onChange={value => setValue('confirmation', value)} placeholder={expectedConfirmation} />
          <div className="flex flex-wrap items-center gap-3">
            <button disabled={mutation.isPending || !confirmationReady || !values.desiredPrimaryHost || !values.desiredStandbyHost} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <ShieldCheck className="h-4 w-4" />
              Preparar failback protegido
            </button>
            {mutation.isSuccess ? <StatusPill value="prepared" /> : null}
            {mutation.isError ? <span className="text-sm text-red-700">{mutation.error.message}</span> : null}
          </div>
        </form>
      </Card>

      {maintenanceFailback ? (
        <Card title="Failback preparado" icon={CheckCircle2} action={<StatusPill value={maintenanceFailback.productionLocked ? 'blocked' : 'warning'} />}>
          <div className="grid gap-3 text-sm">
            {[
              ['Primary desejado', maintenanceFailback.desiredPrimaryHost],
              ['Standby desejado', maintenanceFailback.desiredStandbyHost],
              ['Estrategia', maintenanceFailback.strategyLabel],
              ['Producao bloqueada', maintenanceFailback.productionLocked ? 'sim' : 'nao'],
              ['Validacao de banco exigida', maintenanceFailback.requiresDatabaseValidation ? 'sim' : 'nao']
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{label}</span>
                <span className="text-right font-medium text-slate-950">{value}</span>
              </div>
            ))}
          </div>
          {maintenanceFailback.nextSteps?.length ? (
            <div className="mt-4 grid gap-2 text-sm">
              {maintenanceFailback.nextSteps.map((step, index) => (
                <div key={`${step}-${index}`} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">{step}</div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function MaintenanceView({ dashboard }) {
  const queryClient = useQueryClient();
  const maintenanceQuery = useQuery({ queryKey: ['maintenance'], queryFn: () => api('/api/maintenance'), refetchInterval: 10000 });
  const [tab, setTab] = useState('ha');
  const [jobId, setJobId] = useState(null);
  const actionMutation = useMutation({
    mutationFn: ({ path, confirmation }) => postApi(path, { confirmation }),
    onSuccess: data => {
      setJobId(data.job?.id || null);
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const jobQuery = useQuery({
    queryKey: ['maintenance-job', jobId],
    queryFn: () => api(`/api/actions/${jobId}`),
    enabled: !!jobId,
    refetchInterval: query => query.state.data?.status === 'running' ? 1200 : false
  });
  const data = maintenanceQuery.data || {};
  const cluster = data.cluster || {};
  const sync = data.sync || {};
  const busy = actionMutation.isPending || jobQuery.data?.status === 'running';
  const run = path => payload => actionMutation.mutate({ path, ...payload });
  const maintenanceTabs = [
    { id: 'ha', label: 'Failover HA', icon: ShieldCheck },
    { id: 'failback', label: 'Failback', icon: GitBranch },
    { id: 'power', label: 'Energia', icon: Power },
    { id: 'keepalived', label: 'Keepalived', icon: Network },
    { id: 'diagnostics', label: 'Diagnostico', icon: CheckCircle2 },
    { id: 'events', label: 'Eventos', icon: Terminal },
    { id: 'settings', label: 'Ajustes', icon: Settings }
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="No atual" value={cluster.nodeName || '-'} detail={cluster.nodeRole || '-'} icon={Server} tone="sky" />
        <Stat label="Keepalived local" value={data.local?.keepalived || '-'} detail={cluster.vip || 'VIP nao configurado'} icon={Network} tone={data.local?.keepalived === 'active' ? 'green' : 'amber'} />
        <Stat label="Standby" value={sync.standbyHost || '-'} detail={sync.enabled ? 'sync habilitado' : 'sync desabilitado'} icon={GitBranch} tone={sync.standbyHost ? 'green' : 'amber'} />
        <Stat label="Hora servidor" value={formatDateTime(data.generatedAt)} detail="backend local" icon={FileClock} tone="slate" />
      </div>

      {jobQuery.data ? <ActionTerminal job={jobQuery.data} /> : null}

      <SubTabs items={maintenanceTabs} active={tab} onChange={setTab} />

      {tab === 'ha' ? (
        <Card title="Failover em manutencao" icon={ShieldCheck} action={<StatusPill value={sync.standbyHost ? 'online' : 'warning'} />}>
          <div className="mb-4 grid gap-3 text-sm">
            {[
              ['Host standby', sync.standbyHost || 'nao configurado'],
              ['Usuario SSH', sync.sshUser || 'tronsoft'],
              ['Porta SSH', sync.sshPort || 22],
              ['Uso', 'parar keepalived no standby antes de reiniciar o primary sem failover']
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{label}</span>
                <span className="text-right font-medium text-slate-950">{value}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ConfirmAction label="Suspender failover no standby" icon={Square} confirmation="SUSPENDER STANDBY" tone="amber" disabled={busy || !sync.standbyHost} onConfirm={run('/api/maintenance/standby/keepalived/stop')} />
            <ConfirmAction label="Reativar failover no standby" icon={Play} confirmation="REATIVAR STANDBY" disabled={busy || !sync.standbyHost} onConfirm={run('/api/maintenance/standby/keepalived/start')} />
          </div>
          {actionMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionMutation.error.message}</div> : null}
        </Card>
      ) : null}

      {tab === 'failback' ? <FailbackAssistant dashboard={dashboard} /> : null}

      {tab === 'power' ? (
        <Card title="Energia do host local" icon={Power} action={<StatusPill value="critico" />}>
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Em primary com standby configurado, o TronSoftOS suspende o failover no standby antes de reiniciar ou desligar este host.
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ConfirmAction label="Reiniciar host" icon={RefreshCw} confirmation="REINICIAR HOST" tone="amber" disabled={busy} onConfirm={run('/api/maintenance/host/reboot')} />
            <ConfirmAction label="Desligar host" icon={Power} confirmation="DESLIGAR HOST" tone="red" disabled={busy} onConfirm={run('/api/maintenance/host/poweroff')} />
          </div>
        </Card>
      ) : null}

      {tab === 'keepalived' ? (
        <Card title="Keepalived local" icon={Network}>
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Use estes controles apenas quando estiver operando diretamente no no correto. Em manutencao planejada do primary, normalmente voce suspende o keepalived no standby.
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ConfirmAction label="Parar keepalived local" icon={Square} confirmation="SUSPENDER LOCAL" tone="amber" disabled={busy} onConfirm={run('/api/maintenance/local/keepalived/stop')} />
            <ConfirmAction label="Iniciar keepalived local" icon={Play} confirmation="REATIVAR LOCAL" disabled={busy} onConfirm={run('/api/maintenance/local/keepalived/start')} />
          </div>
        </Card>
      ) : null}

      {tab === 'diagnostics' ? <DiagnosticsView /> : null}
      {tab === 'events' ? <EventsView /> : null}
      {tab === 'settings' ? <SettingsView dashboard={dashboard} /> : null}
    </div>
  );
}

function NetworkSettings() {
  const queryClient = useQueryClient();
  const networkQuery = useQuery({ queryKey: ['host-network'], queryFn: () => api('/api/host/network') });
  const network = networkQuery.data;
  const currentInterface = network?.defaultInterface || network?.interfaces?.[0]?.name || 'eth0';
  const currentAddress = network?.interfaces?.find(item => item.name === currentInterface)?.addresses?.[0]?.cidr || '';
  const currentDns = network?.dns?.join(' ') || '1.1.1.1 8.8.8.8';
  const [form, setForm] = useState(null);
  const values = form || {
    interfaceName: currentInterface,
    addressCidr: currentAddress,
    gateway: network?.gateway || '',
    dns: currentDns,
    applyNow: false
  };
  const mutation = useMutation({
    mutationFn: payload => postApi('/api/host/network/static', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['host-network'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));

  return (
    <Card title="Rede do host" icon={Network} action={networkQuery.isFetching ? <StatusPill value="atualizando" /> : null}>
      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-3 text-sm">
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">Interface atual</span><span className="font-medium">{currentInterface}</span></div>
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">IP atual</span><span className="font-medium">{currentAddress || '-'}</span></div>
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">Gateway</span><span className="font-medium">{network?.gateway || '-'}</span></div>
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">DNS</span><span className="font-medium">{currentDns}</span></div>
          {networkQuery.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">Nao foi possivel ler a rede do host.</div> : null}
        </div>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            mutation.mutate(values);
          }}
        >
          <Field label="Interface" value={values.interfaceName} onChange={value => setValue('interfaceName', value)} placeholder="eth0" />
          <Field label="IP fixo/CIDR" value={values.addressCidr} onChange={value => setValue('addressCidr', value)} placeholder="192.168.1.50/24" />
          <Field label="Gateway" value={values.gateway} onChange={value => setValue('gateway', value)} placeholder="192.168.1.1" />
          <Field label="DNS" value={values.dns} onChange={value => setValue('dns', value)} placeholder="1.1.1.1 8.8.8.8" />
          <div className="md:col-span-2">
            <Checkbox label="Aplicar imediatamente" checked={values.applyNow} onChange={value => setValue('applyNow', value)} />
          </div>
          <div className="flex items-center gap-3 md:col-span-2">
            <button disabled={mutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar rede
            </button>
            {mutation.isSuccess ? <StatusPill value="online" /> : null}
            {mutation.isError ? <span className="text-sm text-red-700">{mutation.error.message}</span> : null}
          </div>
          {mutation.data?.reloadRequired ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 md:col-span-2">
              Arquivos de configuracao atualizados. Reinicie TronSoftOS e TronFire para carregar o novo IP.
            </div>
          ) : null}
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 md:col-span-2">
            Reiniciar ou recriar containers pelo TronSoftOS nao remove os dados persistentes. Firebird e PostgreSQL ficam em /opt/tronfire-storage.
          </div>
        </form>
      </div>
    </Card>
  );
}

function SmtpSettings() {
  const queryClient = useQueryClient();
  const smtpQuery = useQuery({ queryKey: ['smtp-settings'], queryFn: () => api('/api/settings/smtp') });
  const smtp = smtpQuery.data || {};
  const [form, setForm] = useState(null);
  const values = form || {
    enabled: smtp.enabled || false,
    host: smtp.host || '',
    port: smtp.port || 587,
    secure: smtp.secure || false,
    user: smtp.user || '',
    password: '',
    from: smtp.from || '',
    to: smtp.to || '',
    subjectPrefix: smtp.subjectPrefix || '[TronSoftOS]'
  };
  const mutation = useMutation({
    mutationFn: payload => fetch('/api/settings/smtp', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      return response.json();
    }),
    onSuccess: data => {
      setForm({ ...data, password: '' });
      queryClient.invalidateQueries({ queryKey: ['smtp-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));

  return (
    <Card title="SMTP / alertas por email" icon={UploadCloud} action={smtp.passwordConfigured ? <StatusPill value="online" /> : <StatusPill value="warning" />}>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={event => {
          event.preventDefault();
          mutation.mutate(values);
        }}
      >
        <div className="md:col-span-2">
          <Checkbox label="Enviar alertas por email" checked={values.enabled} onChange={value => setValue('enabled', value)} />
        </div>
        <Field label="Servidor SMTP" value={values.host} onChange={value => setValue('host', value)} placeholder="smtp.exemplo.com.br" />
        <Field label="Porta" type="number" value={String(values.port)} onChange={value => setValue('port', Number(value))} placeholder="587" />
        <Field label="Usuario" value={values.user} onChange={value => setValue('user', value)} placeholder="alertas@cliente.com.br" />
        <Field label={smtp.passwordConfigured ? 'Senha nova (opcional)' : 'Senha'} type="password" value={values.password} onChange={value => setValue('password', value)} placeholder={smtp.passwordConfigured ? 'mantem atual se vazio' : ''} />
        <Field label="Remetente" value={values.from} onChange={value => setValue('from', value)} placeholder="TronSoftOS <alertas@cliente.com.br>" />
        <Field label="Destinatarios" value={values.to} onChange={value => setValue('to', value)} placeholder="suporte@revenda.com.br, cliente@empresa.com.br" />
        <Field label="Prefixo assunto" value={values.subjectPrefix} onChange={value => setValue('subjectPrefix', value)} placeholder="[TronSoftOS]" />
        <div className="flex items-center pt-6">
          <Checkbox label="SSL/TLS direto" checked={values.secure} onChange={value => setValue('secure', value)} />
        </div>
        <div className="flex items-center gap-3 md:col-span-2">
          <button disabled={mutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
            <Save className="h-4 w-4" />
            Salvar SMTP
          </button>
          {mutation.isSuccess ? <StatusPill value="online" /> : null}
          {mutation.isError ? <span className="text-sm text-red-700">{mutation.error.message}</span> : null}
        </div>
      </form>
    </Card>
  );
}

function SettingsView({ dashboard }) {
  return (
    <div className="space-y-5">
      <NetworkSettings />
      <SmtpSettings />
    </div>
  );
}

function TronFireView() {
  const [section, setSection] = useState('dashboard');
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: Gauge },
    { id: 'databases', label: 'Bancos', icon: Database },
    { id: 'uploads', label: 'Migracao', icon: UploadCloud },
    { id: 'backups', label: 'Backups', icon: HardDrive },
    { id: 'alerts', label: 'Alertas', icon: AlertTriangle },
    { id: 'logs', label: 'Logs', icon: Terminal }
  ];
  const src = `/tronfire/?embed=1#${section}`;
  return (
    <div className="space-y-5">
      <SubTabs items={tabs} active={section} onChange={setSection} />
      <div className="h-[calc(100vh-10.5rem)] overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
        <iframe
          key={section}
          title="TronFire"
          src={src}
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}

function LoginView({ onAuthenticated }) {
  const [username, setUsername] = useState('tronsoft');
  const [password, setPassword] = useState('');
  const loginMutation = useMutation({
    mutationFn: () => postApi('/api/auth/login', { username, password }),
    onSuccess: data => onAuthenticated(data.user)
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-soft">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-panel-950 text-sky-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <div className="text-xl font-semibold text-slate-950">
              <span>tron</span><span className="text-sky-600">soft</span><span className="ml-1 font-black">OS</span>
            </div>
            <div className="text-sm text-slate-500">Acesso tecnico</div>
          </div>
        </div>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            loginMutation.mutate();
          }}
        >
          <Field label="Usuario" value={username} onChange={setUsername} autoComplete="username" />
          <label className="block">
            <span className="text-xs font-medium uppercase text-slate-500">Senha</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            />
          </label>
          {loginMutation.isError ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {loginMutation.error.message}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={loginMutation.isPending || !username || !password}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-panel-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-panel-800 disabled:opacity-50"
          >
            <LogIn className="h-4 w-4" />
            {loginMutation.isPending ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}

function AuthenticatedApp({ user, onLogout }) {
  const [active, setActive] = useState('dashboard');
  const [actionJobId, setActionJobId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('tronsoftos-theme') || 'light';
    } catch {
      return 'light';
    }
  });
  const [easterEggClicks, setEasterEggClicks] = useState(0);
  const [easterEggVisible, setEasterEggVisible] = useState(false);
  const queryClient = useQueryClient();
  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 8000,
    retry: 1
  });
  const actionMutation = useMutation({
    mutationFn: ({ app, action }) => postApi(`/api/apps/${app}/${action}`),
    onSuccess: (data) => {
      setActionJobId(data.job?.id || null);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }
  });
  const actionJobQuery = useQuery({
    queryKey: ['action-job', actionJobId],
    queryFn: () => api(`/api/actions/${actionJobId}`),
    enabled: !!actionJobId,
    refetchInterval: query => query.state.data?.status === 'running' ? 1200 : false
  });
  useEffect(() => {
    if (actionJobQuery.data && actionJobQuery.data.status !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }
  }, [actionJobQuery.data?.status, queryClient]);
  const dashboard = dashboardQuery.data || fallbackDashboard;
  const appActionPending = actionMutation.isPending || actionJobQuery.data?.status === 'running';
  const activeItem = useMemo(() => navItems.find(item => item.id === active) || navItems[0], [active]);
  const haMaintenance = dashboard.cluster?.maintenance;
  const haMaintenanceActive = haMaintenance?.active === true;
  const reactivateFailoverMutation = useMutation({
    mutationFn: () => postApi('/api/maintenance/standby/keepalived/start', { confirmation: 'REATIVAR STANDBY' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const darkMode = theme === 'dark';

  useEffect(() => {
    try {
      localStorage.setItem('tronsoftos-theme', theme);
    } catch {
      // Theme preference is optional.
    }
  }, [theme]);

  useEffect(() => {
    if (!easterEggVisible) return undefined;
    const timer = setTimeout(() => setEasterEggVisible(false), 4500);
    return () => clearTimeout(timer);
  }, [easterEggVisible]);

  function activateEasterEgg() {
    setEasterEggClicks(current => {
      const next = current + 1;
      if (next >= 10) {
        setEasterEggVisible(true);
        return 0;
      }
      return next;
    });
  }

  const View = {
    dashboard: <DashboardView dashboard={dashboard} />,
    apps: <AppsView dashboard={dashboard} actionPending={appActionPending} actionJob={actionJobQuery.data} onAction={(app, action) => actionMutation.mutate({ app, action })} />,
    tronfire: <TronFireView section="dashboard" />,
    cluster: <ClusterView dashboard={dashboard} />,
    backups: <BackupsView dashboard={dashboard} />,
    cloudflare: <CloudflareView dashboard={dashboard} />,
    updates: <UpdatesView dashboard={dashboard} />,
    maintenance: <MaintenanceView dashboard={dashboard} />
  }[active];

  return (
    <div className={`min-h-screen bg-slate-100 text-slate-950 ${darkMode ? 'theme-dark' : 'theme-light'}`}>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-panel-800 bg-panel-950 text-white lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <button
            type="button"
            onClick={activateEasterEgg}
            aria-label="Status interno"
            className="relative h-9 w-9 shrink-0 rounded-full border-2 border-sky-300 transition hover:border-sky-200 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
          >
            <span className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-400" />
            <span className="absolute left-1 top-1 h-5 w-5 rounded-full border-l-2 border-t-2 border-sky-300" />
          </button>
          <div>
            <div className="text-lg font-semibold leading-none tracking-normal">
              <span className="text-slate-100">tron</span><span className="text-sky-300">soft</span><span className="ml-1 font-black text-white">OS</span>
            </div>
            <div className="text-xs text-slate-400">Appliance Console</div>
          </div>
        </div>
        <nav className="space-y-1 p-3">
          {navItems.map(item => {
            const Icon = item.icon;
            const selected = item.id === active;
            return (
              <button key={item.id} onClick={() => setActive(item.id)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${selected ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/10 hover:text-white'}`}>
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="lg:pl-64">
        <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:px-6">
          <div>
            <div className="text-xs font-medium uppercase text-slate-500">{dashboard.cluster.mode}</div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-950">{activeItem.label}</h1>
              <button
                type="button"
                onClick={activateEasterEgg}
                aria-label="Status interno"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-300 transition hover:text-sky-500"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {dashboardQuery.isError ? <StatusPill value="offline" /> : <StatusPill value="online" />}
            <StatusPill value={dashboard.cluster.nodeRole} />
            <button
              type="button"
              onClick={() => setTheme(darkMode ? 'light' : 'dark')}
              title={darkMode ? 'Ativar tema claro' : 'Ativar tema escuro'}
              aria-label={darkMode ? 'Ativar tema claro' : 'Ativar tema escuro'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onLogout}
              title={`Sair (${user?.name || user?.username || 'usuario'})`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        {easterEggVisible ? (
          <div className="fixed right-4 top-20 z-30 rounded-md border border-amber-300 bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-950 shadow-soft lg:right-6">
            você tem medo!
          </div>
        ) : null}
        {haMaintenanceActive ? (
          <div className="sticky top-16 z-10 border-b border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-950 shadow-sm lg:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                Manutencao HA ativa ha {formatDurationFrom(haMaintenance.startedAt)}: failover suspenso no standby{haMaintenance.standbyHost ? ` (${haMaintenance.standbyHost})` : ''}.
              </div>
              <button
                type="button"
                disabled={reactivateFailoverMutation.isPending || !haMaintenance.standbyHost}
                onClick={() => reactivateFailoverMutation.mutate()}
                className="inline-flex items-center gap-2 rounded-md bg-amber-950 px-3 py-2 text-xs font-medium uppercase text-white hover:bg-amber-900 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Reativar failover
              </button>
            </div>
            {reactivateFailoverMutation.isError ? <div className="mt-2 text-xs text-red-700">{reactivateFailoverMutation.error.message}</div> : null}
          </div>
        ) : null}
        <div className="p-4 lg:p-6">{View}</div>
      </main>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const authQuery = useQuery({
    queryKey: ['auth'],
    queryFn: async () => {
      const response = await fetch('/api/auth/me');
      if (response.status === 401) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    retry: false,
    staleTime: 60_000
  });
  const logoutMutation = useMutation({
    mutationFn: () => postApi('/api/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(['auth'], null);
    }
  });

  if (authQuery.isPending) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">Verificando acesso...</div>;
  }
  if (!authQuery.data?.user) {
    return (
      <LoginView
        onAuthenticated={user => {
          queryClient.setQueryData(['auth'], { user });
        }}
      />
    );
  }
  return <AuthenticatedApp user={authQuery.data.user} onLogout={() => logoutMutation.mutate()} />;
}
