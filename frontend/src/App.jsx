import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Cloud,
  Database,
  FileClock,
  CheckCircle2,
  Gauge,
  GitBranch,
  HardDrive,
  LayoutDashboard,
  Network,
  Play,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
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
  { id: 'diagnostics', label: 'Diagnostico', icon: CheckCircle2 },
  { id: 'apps', label: 'Apps', icon: Boxes },
  { id: 'cluster', label: 'Cluster HA', icon: GitBranch },
  { id: 'backups', label: 'Backups', icon: UploadCloud },
  { id: 'cloudflare', label: 'Cloudflare', icon: Cloud },
  { id: 'updates', label: 'Atualizacoes', icon: RefreshCw },
  { id: 'events', label: 'Eventos', icon: Terminal },
  { id: 'settings', label: 'Ajustes', icon: Settings }
];

const fallbackDashboard = {
  generatedAt: new Date().toISOString(),
  cluster: {
    mode: 'simple',
    nodeName: 'local',
    nodeRole: 'primary',
    vip: 'nao configurado',
    lock: null,
    keepalived: { enabled: false, interface: null, routerId: null }
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
    recentFiles: []
  },
  cloudflare: { recordName: null, recordType: 'A', targetIp: null, tokenConfigured: false },
  alerts: [{ severity: 'warning', message: 'Backend ainda nao retornou dados reais' }]
};

const metricSeries = [
  { time: '00h', cpu: 21, memory: 38, disk: 42 },
  { time: '04h', cpu: 28, memory: 41, disk: 43 },
  { time: '08h', cpu: 36, memory: 45, disk: 44 },
  { time: '12h', cpu: 31, memory: 47, disk: 44 },
  { time: '16h', cpu: 44, memory: 51, disk: 45 },
  { time: '20h', cpu: 26, memory: 43, disk: 45 }
];

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
    degraded: 'bg-amber-100 text-amber-800 border-amber-200',
    warning: 'bg-amber-100 text-amber-800 border-amber-200',
    standby: 'bg-sky-100 text-sky-800 border-sky-200',
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

function diagnosticIcon(status) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  return <XCircle className="h-4 w-4 text-red-600" />;
}

function Card({ title, icon: Icon, children, action }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-soft">
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

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
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
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="No atual" value={dashboard.cluster.nodeName} detail={dashboard.cluster.mode} icon={Server} tone="sky" />
        <Stat label="Papel" value={dashboard.cluster.nodeRole} detail={dashboard.cluster.vip || 'VIP nao configurado'} icon={ShieldCheck} tone="green" />
        <Stat label="Apps online" value={`${onlineApps}/${dashboard.apps.length}`} detail="containers gerenciados" icon={Boxes} tone="slate" />
        <Stat label="Alertas" value={alerts.length} detail={alerts[0]?.message || 'sem alertas ativos'} icon={AlertTriangle} tone={alerts.length ? 'amber' : 'green'} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card title="Topologia" icon={GitBranch}><Topology dashboard={dashboard} /></Card>
        <Card title="Saude" icon={Gauge}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metricSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="time" fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip />
                <Area type="monotone" dataKey="cpu" stroke="#0284c7" fill="#bae6fd" />
                <Area type="monotone" dataKey="memory" stroke="#16a34a" fill="#bbf7d0" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}

function AppsView({ dashboard, onAction, actionPending }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {dashboard.apps.map(app => (
        <Card key={app.name} title={app.name} icon={Boxes} action={<StatusPill value={app.status} />}>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <button disabled={actionPending} onClick={() => onAction(app.name, 'up')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Play className="h-4 w-4" />Subir</button>
            <button disabled={actionPending} onClick={() => onAction(app.name, 'restart')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Reiniciar</button>
            <button disabled={actionPending} onClick={() => onAction(app.name, 'stop')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Square className="h-4 w-4" />Parar</button>
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
  );
}

function DiagnosticsView() {
  const queryClient = useQueryClient();
  const diagnosticsQuery = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api('/api/diagnostics'),
    refetchInterval: 10000
  });
  const firebirdMutation = useMutation({
    mutationFn: action => postApi(`/api/host/firebird/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['diagnostics'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const tronfireMutation = useMutation({
    mutationFn: action => postApi(`/api/apps/tronfire/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['diagnostics'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const diagnostics = diagnosticsQuery.data;
  const checks = diagnostics?.checks || [];
  const busy = firebirdMutation.isPending || tronfireMutation.isPending;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="Estado geral" value={diagnostics?.summary?.ok ? 'OK' : 'Atencao'} detail={diagnosticsQuery.isFetching ? 'atualizando' : diagnostics?.generatedAt ? new Date(diagnostics.generatedAt).toLocaleTimeString() : 'aguardando'} icon={ShieldCheck} tone={diagnostics?.summary?.ok ? 'green' : 'amber'} />
        <Stat label="Erros" value={String(diagnostics?.summary?.errors ?? '-')} detail="checagens criticas" icon={XCircle} tone={(diagnostics?.summary?.errors || 0) > 0 ? 'red' : 'green'} />
        <Stat label="Avisos" value={String(diagnostics?.summary?.warnings ?? '-')} detail="itens pendentes" icon={AlertTriangle} tone={(diagnostics?.summary?.warnings || 0) > 0 ? 'amber' : 'green'} />
        <Stat label="Firebird" value={diagnostics?.firebird?.status || '-'} detail={diagnostics?.tronfire?.firebirdExecMode || 'modo desconhecido'} icon={Database} tone={diagnostics?.firebird?.status === 'active' ? 'green' : 'red'} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
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

        <div className="space-y-5">
          <Card title="Acoes rapidas" icon={Zap}>
            <div className="grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                <button disabled={busy} onClick={() => firebirdMutation.mutate('start')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                  <Play className="h-4 w-4" />
                  Iniciar
                </button>
                <button disabled={busy} onClick={() => firebirdMutation.mutate('restart')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                  <RefreshCw className="h-4 w-4" />
                  Reiniciar
                </button>
                <button disabled={busy} onClick={() => firebirdMutation.mutate('stop')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                  <Square className="h-4 w-4" />
                  Parar
                </button>
              </div>
              <button disabled={busy} onClick={() => tronfireMutation.mutate('restart')} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" />
                Reiniciar TronFire
              </button>
              <button disabled={busy} onClick={() => tronfireMutation.mutate('up')} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                <Play className="h-4 w-4" />
                Subir/Recriar TronFire
              </button>
              {firebirdMutation.isError || tronfireMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{firebirdMutation.error?.message || tronfireMutation.error?.message}</div> : null}
              {firebirdMutation.isSuccess || tronfireMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Acao executada.</div> : null}
            </div>
          </Card>

          <Card title="TronFire" icon={Boxes}>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3 border-b border-slate-100 pb-2"><dt className="text-slate-500">Env</dt><dd className="truncate font-mono text-xs">{diagnostics?.tronfire?.envPath || '-'}</dd></div>
              <div className="flex justify-between gap-3 border-b border-slate-100 pb-2"><dt className="text-slate-500">Modo</dt><dd className="font-medium">{diagnostics?.tronfire?.firebirdExecMode || '-'}</dd></div>
              <div className="flex justify-between gap-3 border-b border-slate-100 pb-2"><dt className="text-slate-500">Health</dt><dd className="truncate font-mono text-xs">{diagnostics?.tronfire?.healthUrl || '-'}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              {(diagnostics?.tronfire?.containers || []).map(container => (
                <div key={container.name} className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-medium">{container.name}</span>
                  <StatusPill value={container.status} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ClusterView({ dashboard }) {
  const cluster = dashboard.cluster;
  return (
    <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <Card title="Estado do cluster" icon={GitBranch}>
        <dl className="grid gap-3 text-sm">
          {[
            ['Modo', cluster.mode],
            ['No', cluster.nodeName],
            ['Papel', cluster.nodeRole],
            ['VIP', cluster.vip || 'nao configurado'],
            ['Keepalived', cluster.keepalived?.enabled ? 'ativo' : 'nao configurado'],
            ['Cluster lock', cluster.lock ? 'presente' : 'ausente']
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{label}</dt>
              <dd className="font-medium text-slate-950">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Topologia HA" icon={Activity}><Topology dashboard={dashboard} /></Card>
    </div>
  );
}

function BackupsView({ dashboard }) {
  const queryClient = useQueryClient();
  const rcloneQuery = useQuery({ queryKey: ['rclone-settings'], queryFn: () => api('/api/backups/rclone') });
  const googleCredentialsQuery = useQuery({ queryKey: ['google-drive-credentials'], queryFn: () => api('/api/backups/google/credentials') });
  const files = dashboard.backups.recentFiles || [];
  const rclone = rcloneQuery.data || dashboard.backups.rclone || {};
  const googleCredentials = googleCredentialsQuery.data || {};
  const [form, setForm] = useState(null);
  const [oauth, setOauth] = useState({ clientId: '', clientSecret: '', redirectUri: '' });
  const [token, setToken] = useState('');
  const values = form || {
    enabled: rclone.enabled || false,
    bin: rclone.bin || '/usr/bin/rclone',
    config: rclone.config || '/opt/tronos/config/rclone/rclone.conf',
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
  const googleMutation = useMutation({
    mutationFn: payload => postApi('/api/backups/google/start', payload),
    onSuccess: data => {
      window.open(data.authUrl, '_blank', 'noopener,noreferrer');
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const credentialsMutation = useMutation({
    mutationFn: content => postApi('/api/backups/google/credentials', { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['google-drive-credentials'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const tokenMutation = useMutation({
    mutationFn: payload => postApi('/api/backups/rclone/token', payload),
    onSuccess: data => {
      setForm({ ...data, configContent: '' });
      setToken('');
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['rclone-settings'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  });
  const setValue = (key, value) => setForm(previous => ({ ...(previous || values), [key]: value }));
  const setOauthValue = (key, value) => setOauth(previous => ({ ...previous, [key]: value }));
  const importCredentialsFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => credentialsMutation.mutate(String(reader.result || ''));
    reader.readAsText(file);
    event.target.value = '';
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
      <Card title="Google Drive / Rclone" icon={UploadCloud} action={<StatusPill value={rclone.configConfigured ? 'online' : 'warning'} />}>
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Credenciais Google OAuth</div>
              <div className="text-xs text-slate-500">{googleCredentials.configured ? `JSON importado: ${googleCredentials.clientId}` : 'Importe o client_secret.json do Google Cloud'}</div>
            </div>
            <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">
              <UploadCloud className="h-4 w-4" />
              Importar JSON
              <input type="file" accept="application/json,.json" className="hidden" onChange={importCredentialsFile} />
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Google Client ID" value={oauth.clientId} onChange={value => setOauthValue('clientId', value)} placeholder={googleCredentials.configured ? 'usando JSON importado' : 'client_id do OAuth'} />
            <Field label="Google Client Secret" type="password" value={oauth.clientSecret} onChange={value => setOauthValue('clientSecret', value)} placeholder={googleCredentials.configured ? 'usando JSON importado' : 'client_secret do OAuth'} />
            <Field label="URL de retorno" value={oauth.redirectUri} onChange={value => setOauthValue('redirectUri', value)} placeholder={`${window.location.origin}/api/backups/google/callback`} />
            <div className="flex items-end">
              <button
                type="button"
                disabled={googleMutation.isPending}
                onClick={() => googleMutation.mutate({ ...values, ...oauth })}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
              >
                <Cloud className="h-4 w-4" />
                Conectar Google Drive
              </button>
            </div>
          </div>
          {credentialsMutation.isSuccess ? <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Credenciais Google importadas.</div> : null}
          {credentialsMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{credentialsMutation.error?.message}</div> : null}
          {googleMutation.isSuccess ? <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Autorizacao aberta em nova aba.</div> : null}
          {googleMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{googleMutation.error?.message}</div> : null}
        </div>
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3">
          <label className="block">
            <span className="text-xs font-medium uppercase text-amber-700">Token OAuth gerado</span>
            <textarea
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder='{"access_token":"...","refresh_token":"...","expiry":"..."}'
              className="mt-1 h-24 w-full rounded-md border border-amber-200 px-3 py-2 font-mono text-xs outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
            />
          </label>
          <div className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-2">
            <span className="text-xs font-medium uppercase text-amber-700">Comando para gerar token</span>
            <code className="mt-1 block select-all rounded bg-slate-950 px-3 py-2 text-xs text-white">rclone authorize "drive"</code>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={tokenMutation.isPending}
              onClick={() => tokenMutation.mutate({ ...values, ...oauth, token })}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Adicionar token
            </button>
            <a className="text-sm font-medium text-amber-800 hover:underline" href="https://rclone.org/commands/rclone_authorize/" target="_blank" rel="noreferrer">Abrir documentacao do comando</a>
          </div>
          {tokenMutation.isSuccess ? <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Token salvo e rclone.conf gerado.</div> : null}
          {tokenMutation.isError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{tokenMutation.error?.message}</div> : null}
        </div>
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
          <Field label="Arquivo rclone.conf" value={values.config} onChange={value => setValue('config', value)} placeholder="/opt/tronos/config/rclone/rclone.conf" />
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
          {testMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Conexao OK: {testMutation.data.target}</div> : null}
          {uploadTestMutation.isSuccess ? <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 md:col-span-2">Upload OK: {uploadTestMutation.data.target}</div> : null}
          {saveMutation.isError || testMutation.isError || uploadTestMutation.isError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-2">{saveMutation.error?.message || testMutation.error?.message || uploadTestMutation.error?.message}</div> : null}
        </form>
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
  return (
    <Card title="Cloudflare" icon={Cloud}>
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Registro" value={dashboard.cloudflare.recordName || '-'} detail={dashboard.cloudflare.recordType} icon={Cloud} />
        <Stat label="Destino" value={dashboard.cloudflare.targetIp || '-'} detail="VIP ou IP ativo" icon={Zap} />
        <Stat label="Token" value={dashboard.cloudflare.tokenConfigured ? 'OK' : 'Pendente'} detail="API Cloudflare" icon={ShieldCheck} tone={dashboard.cloudflare.tokenConfigured ? 'green' : 'amber'} />
        <Stat label="Proxy" value="Planejado" detail="Tunnel/DNS API" icon={Activity} />
      </div>
    </Card>
  );
}

function UpdatesView() {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Plano de atualizacao" icon={RefreshCw}>
        <ol className="space-y-3 text-sm text-slate-700">
          {['Backup de configuracao', 'Export catalogo TronFire', 'Backup Firebird', 'Atualizar standby primeiro em HA', 'Aplicar migrations', 'Validar health checks'].map(item => (
            <li key={item} className="flex items-center gap-2"><span className="status-dot bg-slate-300" />{item}</li>
          ))}
        </ol>
      </Card>
      <Card title="Compatibilidade" icon={Database}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[{ name: 'TronSoftOS', version: 1 }, { name: 'TronFire', version: 1 }, { name: 'TronComanda', version: 0 }]}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" fontSize={12} />
              <YAxis fontSize={12} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="version" fill="#0284c7" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
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

function SettingsView() {
  return (
    <div className="space-y-5">
      <Card title="Ajustes" icon={Settings}>
        <div className="grid gap-4 md:grid-cols-3">
          <Stat label="Firebird" value="2.5.9" detail="host ou container" icon={Database} />
          <Stat label="Rclone" value="Host" detail="Debian/systemd" icon={HardDrive} />
          <Stat label="Containers" value="Catalogo" detail="managed-apps.json" icon={Boxes} />
        </div>
      </Card>
      <NetworkSettings />
      <SmtpSettings />
      <Card title="Pareamento HA" icon={ShieldCheck}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">Arquivo do no principal</div>
            <div className="mt-1 text-sm text-slate-500">Use este arquivo no wizard do servidor standby para compartilhar os segredos do cluster.</div>
          </div>
          <a href="/api/cluster/pairing-file" className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50">
            <UploadCloud className="h-4 w-4" />
            Exportar arquivo
          </a>
        </div>
      </Card>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState('dashboard');
  const queryClient = useQueryClient();
  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 8000,
    retry: 1
  });
  const actionMutation = useMutation({
    mutationFn: ({ app, action }) => postApi(`/api/apps/${app}/${action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  });
  const dashboard = dashboardQuery.data || fallbackDashboard;
  const activeItem = useMemo(() => navItems.find(item => item.id === active) || navItems[0], [active]);

  const View = {
    dashboard: <DashboardView dashboard={dashboard} />,
    diagnostics: <DiagnosticsView />,
    apps: <AppsView dashboard={dashboard} actionPending={actionMutation.isPending} onAction={(app, action) => actionMutation.mutate({ app, action })} />,
    cluster: <ClusterView dashboard={dashboard} />,
    backups: <BackupsView dashboard={dashboard} />,
    cloudflare: <CloudflareView dashboard={dashboard} />,
    updates: <UpdatesView />,
    events: <EventsView />,
    settings: <SettingsView />
  }[active];

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-panel-800 bg-panel-950 text-white lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-sky-500 font-bold">T</div>
          <div>
            <div className="text-sm font-semibold">TronSoftOS</div>
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
            <h1 className="text-xl font-semibold text-slate-950">{activeItem.label}</h1>
          </div>
          <div className="flex items-center gap-3">
            {dashboardQuery.isError ? <StatusPill value="offline" /> : <StatusPill value="online" />}
            <StatusPill value={dashboard.cluster.nodeRole} />
          </div>
        </header>
        <div className="p-4 lg:p-6">{View}</div>
      </main>
    </div>
  );
}
