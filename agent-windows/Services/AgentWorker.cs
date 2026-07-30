using System.Text.Json;
using System.Diagnostics;
using System.Reflection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TronSoft.Agent.Windows;
using TronSoft.Agent.Windows.Infrastructure;

namespace TronSoft.Agent.Windows.Services;

public sealed class AgentWorker : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly IOptionsMonitor<AgentOptions> _options;
    private readonly AgentPaths _paths;
    private readonly LocalStore _store;
    private readonly CentralClient _central;
    private readonly ServerMetricsCollector _serverMetrics;
    private readonly ContainerInventoryCollector _containerInventory;
    private readonly FirebirdCollector _firebird;
    private readonly BackupCollector _backup;
    private readonly ILogger<AgentWorker> _logger;

    public AgentWorker(
        IOptionsMonitor<AgentOptions> options,
        AgentPaths paths,
        LocalStore store,
        CentralClient central,
        ServerMetricsCollector serverMetrics,
        ContainerInventoryCollector containerInventory,
        FirebirdCollector firebird,
        BackupCollector backup,
        ILogger<AgentWorker> logger)
    {
        _options = options;
        _paths = paths;
        _store = store;
        _central = central;
        _serverMetrics = serverMetrics;
        _containerInventory = containerInventory;
        _firebird = firebird;
        _backup = backup;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Falha no ciclo do Agent Windows");
                _store.AddEvent("TICK_FAILED", new { error = ex.Message });
            }

            var interval = TimeSpan.FromSeconds(Math.Clamp(_options.CurrentValue.HeartbeatIntervalSeconds, 30, 3600));
            await Task.Delay(interval, stoppingToken);
        }
    }

    private async Task TickAsync(CancellationToken cancellationToken)
    {
        var payload = await BuildPayloadAsync(cancellationToken);
        File.WriteAllText(_paths.LastHeartbeatFile, JsonSerializer.Serialize(payload, JsonOptions));

        var token = await _central.EnsurePairedAsync(payload, cancellationToken);
        await FlushQueueAsync(token, cancellationToken);

        try
        {
            await _central.SendHeartbeatAsync(token, payload, cancellationToken);
            await SendAlertsAsync(token, payload.Alerts, cancellationToken);
            _store.SetSetting("lastHeartbeatAt", DateTimeOffset.UtcNow.ToString("O"));
        }
        catch
        {
            _store.EnqueueHeartbeat(payload);
            throw;
        }
    }

    private async Task<AgentHeartbeatPayload> BuildPayloadAsync(CancellationToken cancellationToken)
    {
        var config = _options.CurrentValue;
        var host = await _serverMetrics.CollectAsync(cancellationToken);
        var services = await _containerInventory.CollectAsync(cancellationToken);
        var database = await _firebird.CollectAsync(cancellationToken);
        var backups = _backup.Collect();
        var alerts = BuildAlerts(database, backups);

        return new AgentHeartbeatPayload
        {
            InstallationId = EffectiveInstallationId(config),
            Status = alerts.Any(alert => alert.Severity == "critical") ? "warning" : "online",
            Environment = new { name = config.EnvironmentName },
            Tronsoftos = new
            {
                version = ThisAssemblyVersion(),
                build = "",
                channel = "windows-agent"
            },
            Agent = new
            {
                type = "windows_agent",
                version = ThisAssemblyVersion(),
                installedPath = AppContext.BaseDirectory
            },
            Host = host.ToHostPayload(),
            Database = database,
            Backups = backups,
            Services = services,
            Metrics = new
            {
                systemMetrics = host.ToSystemMetricsPayload(),
                hostUptimeSeconds = host.UptimeSeconds,
                cpuPercent = host.CpuPercent,
                memoryPercent = host.Memory.UsedPercent,
                diskUsedPercent = host.DiskUsedPercent
            },
            Alerts = alerts
        };
    }

    private async Task FlushQueueAsync(string token, CancellationToken cancellationToken)
    {
        foreach (var queued in _store.GetQueuedHeartbeats())
        {
            var payload = JsonSerializer.Deserialize<object>(queued.Payload, JsonOptions);
            if (payload is null)
            {
                _store.DeleteQueuedHeartbeat(queued.Id);
                continue;
            }
            await _central.SendHeartbeatAsync(token, payload, cancellationToken);
            _store.DeleteQueuedHeartbeat(queued.Id);
        }
    }

    private async Task SendAlertsAsync(string token, IReadOnlyList<AgentAlert> alerts, CancellationToken cancellationToken)
    {
        foreach (var alert in alerts)
        {
            await _central.SendAlertAsync(token, alert, cancellationToken);
        }
    }

    private static IReadOnlyList<AgentAlert> BuildAlerts(object database, object backups)
    {
        var alerts = new List<AgentAlert>();
        using var databaseJson = JsonDocument.Parse(JsonSerializer.Serialize(database, JsonOptions));
        var db = databaseJson.RootElement;
        if (db.TryGetProperty("indexHealth", out var indexHealth)
            && indexHealth.ValueKind == JsonValueKind.Object
            && indexHealth.TryGetProperty("severity", out var severity)
            && string.Equals(severity.GetString(), "CRITICAL", StringComparison.OrdinalIgnoreCase))
        {
            alerts.Add(new AgentAlert(
                "critical",
                "Banco Firebird sem indices criticos",
                "Uma ou mais tabelas criticas estao sem indice ativo.",
                "DATABASE_MISSING_ACTIVE_INDEXES",
                JsonSerializer.Deserialize<object>(indexHealth.GetRawText(), JsonOptions) ?? new { }));
        }
        if (db.TryGetProperty("indexAudit", out var indexAudit)
            && indexAudit.ValueKind == JsonValueKind.Object
            && indexAudit.TryGetProperty("inactiveDelta", out var inactiveDelta)
            && inactiveDelta.TryGetInt32(out var delta)
            && delta > 0)
        {
            alerts.Add(new AgentAlert(
                "critical",
                $"Indices Firebird inativados: +{delta}",
                $"Foram detectados {delta} novo(s) indice(s) inativo(s) desde a ultima coleta.",
                "DATABASE_INDEXES_BECAME_INACTIVE",
                JsonSerializer.Deserialize<object>(indexAudit.GetRawText(), JsonOptions) ?? new { }));
        }
        else if (db.TryGetProperty("indexAudit", out indexAudit)
            && indexAudit.ValueKind == JsonValueKind.Object
            && indexAudit.TryGetProperty("inactiveIndexes", out var inactiveIndexes)
            && inactiveIndexes.TryGetInt32(out var inactiveCount)
            && inactiveCount > 0)
        {
            alerts.Add(new AgentAlert(
                "warning",
                $"Banco Firebird com {inactiveCount} indices inativos",
                "O banco possui indices inativos. Verifique se houve restore com -i ou rotina de manutencao interrompida.",
                "DATABASE_INACTIVE_INDEXES_PRESENT",
                JsonSerializer.Deserialize<object>(indexAudit.GetRawText(), JsonOptions) ?? new { }));
        }

        using var backupJson = JsonDocument.Parse(JsonSerializer.Serialize(backups, JsonOptions));
        var backup = backupJson.RootElement;
        if (backup.TryGetProperty("status", out var backupStatus)
            && string.Equals(backupStatus.GetString(), "warning", StringComparison.OrdinalIgnoreCase))
        {
            alerts.Add(new AgentAlert(
                "warning",
                "Backup local atrasado ou nao encontrado",
                "O Agent Windows nao encontrou backup recente dentro do limite configurado.",
                "WINDOWS_BACKUP_STALE",
                JsonSerializer.Deserialize<object>(backup.GetRawText(), JsonOptions) ?? new { }));
        }

        return alerts;
    }

    private string EffectiveInstallationId(AgentOptions config)
    {
        var saved = _store.GetSetting("installationId");
        if (!string.IsNullOrWhiteSpace(saved)) return saved;
        if (!string.IsNullOrWhiteSpace(config.InstallationId)) return config.InstallationId.Trim();
        return $"windows-{Environment.MachineName}".ToLowerInvariant();
    }

    private static string ThisAssemblyVersion()
    {
        var assembly = typeof(AgentWorker).Assembly;
        var informationalVersion = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion?
            .Split('+')[0]
            .Trim();
        if (!string.IsNullOrWhiteSpace(informationalVersion)) return informationalVersion;

        var processPath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
        if (!string.IsNullOrWhiteSpace(processPath))
        {
            var fileVersion = FileVersionInfo.GetVersionInfo(processPath).FileVersion;
            if (!string.IsNullOrWhiteSpace(fileVersion)) return fileVersion.Trim();
        }

        return assembly.GetName().Version?.ToString() ?? "0.1.0";
    }
}

public sealed class AgentHeartbeatPayload
{
    public string InstallationId { get; set; } = "";
    public string Status { get; set; } = "online";
    public object Environment { get; set; } = new { };
    public object Tronsoftos { get; set; } = new { };
    public object Agent { get; set; } = new { };
    public object Host { get; set; } = new { };
    public object Database { get; set; } = new { };
    public object Backups { get; set; } = new { };
    public object Services { get; set; } = new { };
    public object Metrics { get; set; } = new { };
    public IReadOnlyList<AgentAlert> Alerts { get; set; } = Array.Empty<AgentAlert>();
}

public sealed record AgentAlert(string Severity, string Title, string Message, string Code, object Details);
