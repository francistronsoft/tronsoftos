using Microsoft.Extensions.Options;
using TronSoft.Agent.Windows;

namespace TronSoft.Agent.Windows.Services;

public sealed class BackupCollector
{
    private readonly IOptionsMonitor<AgentOptions> _options;

    public BackupCollector(IOptionsMonitor<AgentOptions> options)
    {
        _options = options;
    }

    public object Collect()
    {
        var config = _options.CurrentValue.Backups;
        if (string.IsNullOrWhiteSpace(config.Directory) || !Directory.Exists(config.Directory))
        {
            return new
            {
                configured = false,
                directory = config.Directory,
                status = "unknown",
                message = "Diretorio de backup nao encontrado"
            };
        }

        var files = Directory.EnumerateFiles(config.Directory, "*.*", SearchOption.TopDirectoryOnly)
            .Select(path => new FileInfo(path))
            .Where(file => file.Exists)
            .OrderByDescending(file => file.LastWriteTimeUtc)
            .Take(10)
            .Select(file => new
            {
                name = file.Name,
                path = file.FullName,
                sizeBytes = file.Length,
                lastWriteAt = file.LastWriteTimeUtc
            })
            .ToArray();

        var last = files.FirstOrDefault();
        var maxAge = TimeSpan.FromHours(Math.Max(1, config.MaxAgeHours));
        var status = last is null ? "warning" : DateTime.UtcNow - last.lastWriteAt > maxAge ? "warning" : "ok";

        return new
        {
            configured = true,
            directory = config.Directory,
            status,
            maxAgeHours = config.MaxAgeHours,
            lastBackupAt = last?.lastWriteAt,
            recentFiles = files
        };
    }
}
