using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Microsoft.Win32;
using TronSoft.Agent.Windows;
using TronSoft.Agent.Windows.Infrastructure;

namespace TronSoft.Agent.Windows.Services;

public sealed class FirebirdCollector
{
    private static readonly string[] CriticalIndexTables =
    {
        "CAIXA",
        "COMANDA",
        "ITEM_COMANDA",
        "NF_VENDA",
        "TITULO",
        "PESSOA",
        "ITEM_CARDAPIO",
        "ITEM_CARDAPIOXEMPRESA",
        "ITENS_NF",
        "PEDIDO_TELEENTREGA",
        "PRODUTO",
        "PRODUTOXEMPRESA"
    };

    private readonly IOptionsMonitor<AgentOptions> _options;
    private readonly LocalStore _store;

    public FirebirdCollector(IOptionsMonitor<AgentOptions> options, LocalStore store)
    {
        _options = options;
        _store = store;
    }

    public async Task<object> CollectAsync(CancellationToken cancellationToken)
    {
        var config = _options.CurrentValue.Firebird;
        if (!config.Enabled)
        {
            return new { engine = "Firebird", enabled = false };
        }

        var databasePath = config.DatabasePath;
        var file = string.IsNullOrWhiteSpace(databasePath) ? null : new FileInfo(databasePath);
        var databaseAlias = ResolveDatabaseAlias(config.Alias, databasePath);
        var isql = ResolveIsql(config.IsqlPath, databasePath);
        var indexHealth = isql is null
            ? IndexHealth.Unknown("isql.exe nao encontrado. Informe o caminho do Firebird isql no instalador ou em agent.json.")
            : file?.Exists != true
                ? IndexHealth.Unknown("Arquivo FDB nao encontrado.")
                : await QueryIndexHealthAsync(isql, config, cancellationToken);
        var indexAudit = BuildIndexAudit(databasePath, indexHealth);
        var version = isql is null || file?.Exists != true
            ? null
            : await QueryVersionBancoAsync(isql, config, cancellationToken);

        return new
        {
            engine = "Firebird",
            version = DetectFirebirdVersion(databasePath),
            versaoBanco = version,
            versao_banco = version,
            schemaVersion = version,
            databaseAlias,
            alias = databaseAlias,
            databasePath,
            fileSizeBytes = file?.Exists == true ? (long?)file.Length : null,
            sizeMb = file?.Exists == true ? Math.Round(file.Length / 1024d / 1024d, 1) : (double?)null,
            isqlConfigured = isql is not null,
            isqlPath = isql,
            indexHealth,
            indexAudit
        };
    }

    private IndexAudit BuildIndexAudit(string databasePath, IndexHealth? health)
    {
        var checkedAt = DateTimeOffset.UtcNow;
        if (health is null || health.TotalIndexes is null || health.ActiveIndexes is null || health.InactiveIndexes is null)
        {
            return new IndexAudit
            {
                Status = "unknown",
                CheckedAt = checkedAt,
                Error = health?.Error
            };
        }

        var inactiveNames = health.InactiveIndexesList
            .Select(item => $"{item.TableName}.{item.IndexName}")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(item => item, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var previous = _store.GetLatestIndexSnapshot(databasePath);
        var added = previous is null
            ? inactiveNames
            : inactiveNames.Except(previous.InactiveNames, StringComparer.OrdinalIgnoreCase).ToArray();
        var removed = previous is null
            ? Array.Empty<string>()
            : previous.InactiveNames.Except(inactiveNames, StringComparer.OrdinalIgnoreCase).ToArray();
        var audit = new IndexAudit
        {
            Status = health.InactiveIndexes > 0 ? "attention" : "ok",
            CheckedAt = checkedAt,
            TotalIndexes = health.TotalIndexes,
            ActiveIndexes = health.ActiveIndexes,
            InactiveIndexes = health.InactiveIndexes,
            TransactionHealth = health.TransactionHealth,
            OldestTransaction = health.OldestTransaction ?? health.TransactionHealth?.OldestTransaction,
            OldestActive = health.OldestActive ?? health.TransactionHealth?.OldestActive,
            OldestSnapshot = health.OldestSnapshot ?? health.TransactionHealth?.OldestSnapshot,
            NextTransaction = health.NextTransaction ?? health.TransactionHealth?.NextTransaction,
            SweepInterval = health.SweepInterval ?? health.TransactionHealth?.SweepInterval,
            PreviousInactiveIndexes = previous?.InactiveIndexes,
            InactiveDelta = previous is null ? 0 : health.InactiveIndexes.Value - previous.InactiveIndexes,
            NewInactiveIndexes = added.Take(100).ToArray(),
            ReactivatedIndexes = removed.Take(100).ToArray(),
            InactiveIndexesSample = inactiveNames.Take(200).ToArray(),
            InactiveIndexesTruncated = inactiveNames.Length > 200,
            FirstSnapshot = previous is null,
            PreviousCheckedAt = previous?.CreatedAt
        };

        _store.AddIndexSnapshot(new IndexSnapshotRecord(
            databasePath,
            health.TotalIndexes.Value,
            health.ActiveIndexes.Value,
            health.InactiveIndexes.Value,
            inactiveNames,
            checkedAt));

        return audit;
    }

    private static async Task<string?> QueryVersionBancoAsync(string isql, FirebirdOptions config, CancellationToken cancellationToken)
    {
        var sql = """
            SET HEADING OFF;
            SET LIST OFF;
            SELECT FIRST 1 * FROM VERSAO_BANCO;
            COMMIT;
            QUIT;
            """;
        try
        {
            var result = await RunIsqlAsync(isql, config, sql, cancellationToken);
            return Regex.Match(result.Stdout, @"\b\d{2,}\b").Value.NullIfWhiteSpace();
        }
        catch
        {
            return null;
        }
    }

    private static string ResolveDatabaseAlias(string configuredAlias, string databasePath)
    {
        if (!string.IsNullOrWhiteSpace(configuredAlias)) return configuredAlias.Trim();
        if (string.IsNullOrWhiteSpace(databasePath)) return "";
        var fileName = Path.GetFileNameWithoutExtension(databasePath);
        return string.IsNullOrWhiteSpace(fileName) ? "" : fileName.Trim().ToLowerInvariant();
    }

    private static async Task<IndexHealth?> QueryIndexHealthAsync(string isql, FirebirdOptions config, CancellationToken cancellationToken)
    {
        var sql = """
            SET HEADING OFF;
            SET LIST OFF;
            SELECT
              'TRONIDX_TOTAL|' || COUNT(*) || '|' ||
              SUM(CASE WHEN COALESCE(RDB$INDEX_INACTIVE, 0) = 0 THEN 1 ELSE 0 END) || '|' ||
              SUM(CASE WHEN COALESCE(RDB$INDEX_INACTIVE, 0) = 1 THEN 1 ELSE 0 END)
            FROM RDB$INDICES;
            SELECT
              'TRONIDX_USER_NON_CONSTRAINT|' || COUNT(*) || '|' ||
              SUM(CASE WHEN COALESCE(I.RDB$INDEX_INACTIVE, 0) = 0 THEN 1 ELSE 0 END) || '|' ||
              SUM(CASE WHEN COALESCE(I.RDB$INDEX_INACTIVE, 0) = 1 THEN 1 ELSE 0 END)
            FROM RDB$INDICES I
            WHERE COALESCE(I.RDB$SYSTEM_FLAG, 0) = 0
              AND NOT EXISTS (
                SELECT 1
                FROM RDB$RELATION_CONSTRAINTS RC
                WHERE RC.RDB$INDEX_NAME = I.RDB$INDEX_NAME
              );
            SELECT
              'TRONIDX_TABLE|' || COALESCE(REPLACE(TRIM(RDB$RELATION_NAME), '|', '/'), '') || '|' || COUNT(*) || '|' ||
              SUM(CASE WHEN COALESCE(RDB$INDEX_INACTIVE, 0) = 0 THEN 1 ELSE 0 END) || '|' ||
              SUM(CASE WHEN COALESCE(RDB$INDEX_INACTIVE, 0) = 1 THEN 1 ELSE 0 END)
            FROM RDB$INDICES
            GROUP BY RDB$RELATION_NAME
            ORDER BY RDB$RELATION_NAME;
            SELECT
              'TRONIDX_INACTIVE|' ||
              COALESCE(REPLACE(TRIM(RDB$RELATION_NAME), '|', '/'), '') || '|' ||
              COALESCE(REPLACE(TRIM(RDB$INDEX_NAME), '|', '/'), '') || '|' ||
              COALESCE(CAST(RDB$UNIQUE_FLAG AS VARCHAR(10)), '') || '|' ||
              COALESCE(CAST(RDB$SYSTEM_FLAG AS VARCHAR(10)), '')
            FROM RDB$INDICES
            WHERE COALESCE(RDB$INDEX_INACTIVE, 0) = 1;
            SELECT
              'TRONIDX_TRANSACTIONS|' ||
              COALESCE(CAST(MON$OLDEST_TRANSACTION AS VARCHAR(20)), '') || '|' ||
              COALESCE(CAST(MON$OLDEST_ACTIVE AS VARCHAR(20)), '') || '|' ||
              COALESCE(CAST(MON$OLDEST_SNAPSHOT AS VARCHAR(20)), '') || '|' ||
              COALESCE(CAST(MON$NEXT_TRANSACTION AS VARCHAR(20)), '')
            FROM MON$DATABASE;
            COMMIT;
            QUIT;
            """;
        try
        {
            var result = await RunIsqlAsync(isql, config, sql, cancellationToken);
            return ParseIndexHealth(result.Stdout);
        }
        catch (Exception ex)
        {
            return IndexHealth.Unknown(ex.Message);
        }
    }

    private static async Task<ShellResult> RunIsqlAsync(string isql, FirebirdOptions config, string sql, CancellationToken cancellationToken)
    {
        var databaseTarget = ResolveDatabaseTarget(config);
        var timeoutMs = Math.Clamp(config.QueryTimeoutSeconds, 5, 180) * 1000;
        var args = $"-q -user {Quote(config.User)} -password {Quote(config.Password)} {Quote(databaseTarget)}";
        ShellResult result;
        try
        {
            result = await Shell.RunAsync(isql, args, sql, timeoutMs, cancellationToken);
        }
        catch (TimeoutException ex)
        {
            throw new TimeoutException($"Consulta Firebird excedeu {timeoutMs / 1000}s usando {databaseTarget}. Verifique se o servico Firebird esta ativo e se o caminho do FDB esta correto.", ex);
        }

        if (result.ExitCode != 0) throw new InvalidOperationException(result.Stderr.NullIfWhiteSpace() ?? $"isql exit {result.ExitCode}");
        return result;
    }

    private static string ResolveDatabaseTarget(FirebirdOptions config)
    {
        var databasePath = config.DatabasePath.Trim();
        if (string.IsNullOrWhiteSpace(databasePath)) return databasePath;

        var host = string.IsNullOrWhiteSpace(config.Host) ? "localhost" : config.Host.Trim();
        if (string.IsNullOrWhiteSpace(host)) return databasePath;
        if (!IsWindowsDrivePath(databasePath)) return databasePath;

        return $"{host}:{databasePath}";
    }

    private static bool IsWindowsDrivePath(string value)
    {
        return value.Length >= 3
            && char.IsLetter(value[0])
            && value[1] == ':'
            && (value[2] == '\\' || value[2] == '/');
    }

    private static IndexHealth ParseIndexHealth(string stdout)
    {
        var health = new IndexHealth { CheckedAt = DateTimeOffset.UtcNow };
        var tables = new List<IndexTableHealth>();
        var inactiveIndexes = new List<IndexItemHealth>();

        foreach (var line in stdout.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).Select(item => item.Trim()))
        {
            var parts = line.Split('|');
            if (parts.Length < 4) continue;
            if (parts[0] == "TRONIDX_TOTAL")
            {
                health.TotalIndexes = Number(parts[1]);
                health.ActiveIndexes = Number(parts[2]);
                health.InactiveIndexes = Number(parts[3]);
            }
            else if (parts[0] == "TRONIDX_USER_NON_CONSTRAINT")
            {
                health.UserIndexes = Number(parts[1]);
                health.ActiveUserIndexes = Number(parts[2]);
                health.InactiveUserIndexes = Number(parts[3]);
            }
            else if (parts[0] == "TRONIDX_TABLE" && parts.Length >= 5)
            {
                tables.Add(new IndexTableHealth(parts[1].Trim(), Number(parts[2]), Number(parts[3]), Number(parts[4])));
            }
            else if (parts[0] == "TRONIDX_INACTIVE" && parts.Length >= 5)
            {
                inactiveIndexes.Add(new IndexItemHealth(parts[1].Trim(), parts[2].Trim(), Number(parts[3]), Number(parts[4])));
            }
            else if (parts[0] == "TRONIDX_TRANSACTIONS" && parts.Length >= 5)
            {
                health.TransactionHealth = new FirebirdTransactionHealth
                {
                    OldestTransaction = NullableNumber(parts[1]),
                    OldestActive = NullableNumber(parts[2]),
                    OldestSnapshot = NullableNumber(parts[3]),
                    NextTransaction = NullableNumber(parts[4])
                };
                health.OldestTransaction = health.TransactionHealth.OldestTransaction;
                health.OldestActive = health.TransactionHealth.OldestActive;
                health.OldestSnapshot = health.TransactionHealth.OldestSnapshot;
                health.NextTransaction = health.TransactionHealth.NextTransaction;
            }
        }

        health.Tables = tables;
        health.InactiveIndexesList = inactiveIndexes;
        if (health.TotalIndexes is null && tables.Count == 0)
        {
            return IndexHealth.Unknown("A consulta de indices nao retornou dados.");
        }
        health.MissingActiveTables = tables
            .Where(table => CriticalIndexTables.Contains(table.TableName, StringComparer.OrdinalIgnoreCase) && table.Total > 0 && table.Active == 0)
            .Select(table => table.TableName)
            .ToArray();
        health.Severity = health.MissingActiveTables.Length > 0 ? "CRITICAL" : "OK";
        return health;
    }

    private static string? ResolveIsql(string configuredPath, string databasePath)
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(configuredPath)) candidates.Add(configuredPath);

        var databaseDirectory = string.IsNullOrWhiteSpace(databasePath) ? null : Path.GetDirectoryName(databasePath);
        if (!string.IsNullOrWhiteSpace(databaseDirectory))
        {
            candidates.Add(Path.Combine(databaseDirectory, "isql.exe"));
            candidates.Add(Path.Combine(databaseDirectory, "bin", "isql.exe"));
        }

        candidates.AddRange(FirebirdRegistryRoots().Select(root => Path.Combine(root, "bin", "isql.exe")));
        candidates.AddRange(FirebirdRegistryRoots().Select(root => Path.Combine(root, "isql.exe")));

        candidates.AddRange(new[]
        {
            @"C:\Program Files\Firebird\Firebird_2_5\bin\isql.exe",
            @"C:\Program Files (x86)\Firebird\Firebird_2_5\bin\isql.exe",
            @"C:\Program Files\Firebird\Firebird_3_0\isql.exe",
            @"C:\Program Files\Firebird\Firebird_3_0\bin\isql.exe",
            @"C:\Program Files (x86)\Firebird\Firebird_3_0\isql.exe",
            @"C:\Program Files (x86)\Firebird\Firebird_3_0\bin\isql.exe",
            @"C:\Program Files\Firebird\Firebird_4_0\isql.exe",
            @"C:\Program Files\Firebird\Firebird_4_0\bin\isql.exe",
            @"C:\Program Files (x86)\Firebird\Firebird_4_0\isql.exe",
            @"C:\Program Files (x86)\Firebird\Firebird_4_0\bin\isql.exe"
        });

        candidates.AddRange(FirebirdDirectoryCandidates());

        return candidates
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists);
    }

    private static IEnumerable<string> FirebirdRegistryRoots()
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var instances = root.OpenSubKey(@"SOFTWARE\Firebird Project\Firebird Server\Instances");
            if (instances is null) continue;

            foreach (var valueName in instances.GetValueNames())
            {
                var value = instances.GetValue(valueName)?.ToString();
                if (!string.IsNullOrWhiteSpace(value)) yield return value;
            }
        }
    }

    private static IEnumerable<string> FirebirdDirectoryCandidates()
    {
        foreach (var basePath in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            if (string.IsNullOrWhiteSpace(basePath)) continue;
            var firebirdRoot = Path.Combine(basePath, "Firebird");
            if (!Directory.Exists(firebirdRoot)) continue;
            foreach (var directory in Directory.EnumerateDirectories(firebirdRoot, "Firebird_*"))
            {
                yield return Path.Combine(directory, "bin", "isql.exe");
                yield return Path.Combine(directory, "isql.exe");
            }
        }
    }

    private static string? DetectFirebirdVersion(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (path.Contains("Firebird_4", StringComparison.OrdinalIgnoreCase)) return "4";
        if (path.Contains("Firebird_3", StringComparison.OrdinalIgnoreCase)) return "3";
        return "2.5";
    }

    private static int Number(string value) => int.TryParse(value.Trim(), out var number) ? number : 0;
    private static long? NullableNumber(string value) => long.TryParse(value.Trim(), out var number) ? number : null;

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
}

public sealed class IndexHealth
{
    public int? TotalIndexes { get; set; }
    public int? ActiveIndexes { get; set; }
    public int? InactiveIndexes { get; set; }
    public int? UserIndexes { get; set; }
    public int? ActiveUserIndexes { get; set; }
    public int? InactiveUserIndexes { get; set; }
    public FirebirdTransactionHealth? TransactionHealth { get; set; }
    public long? OldestTransaction { get; set; }
    public long? OldestActive { get; set; }
    public long? OldestSnapshot { get; set; }
    public long? NextTransaction { get; set; }
    public long? SweepInterval { get; set; }
    public string Severity { get; set; } = "UNKNOWN";
    public string[] MissingActiveTables { get; set; } = Array.Empty<string>();
    public DateTimeOffset CheckedAt { get; set; }
    public string? Error { get; set; }
    public IReadOnlyList<IndexTableHealth> Tables { get; set; } = Array.Empty<IndexTableHealth>();
    public IReadOnlyList<IndexItemHealth> InactiveIndexesList { get; set; } = Array.Empty<IndexItemHealth>();

    public static IndexHealth Unknown(string error) => new()
    {
        Severity = "UNKNOWN",
        Error = error,
        CheckedAt = DateTimeOffset.UtcNow
    };
}

public sealed record IndexTableHealth(string TableName, int Total, int Active, int Inactive);
public sealed record IndexItemHealth(string TableName, string IndexName, int Unique, int System);

public sealed class FirebirdTransactionHealth
{
    public long? OldestTransaction { get; set; }
    public long? OldestActive { get; set; }
    public long? OldestSnapshot { get; set; }
    public long? NextTransaction { get; set; }
    public long? SweepInterval { get; set; }
}

public sealed class IndexAudit
{
    public string Status { get; set; } = "unknown";
    public DateTimeOffset CheckedAt { get; set; }
    public int? TotalIndexes { get; set; }
    public int? ActiveIndexes { get; set; }
    public int? InactiveIndexes { get; set; }
    public FirebirdTransactionHealth? TransactionHealth { get; set; }
    public long? OldestTransaction { get; set; }
    public long? OldestActive { get; set; }
    public long? OldestSnapshot { get; set; }
    public long? NextTransaction { get; set; }
    public long? SweepInterval { get; set; }
    public int? PreviousInactiveIndexes { get; set; }
    public int InactiveDelta { get; set; }
    public IReadOnlyList<string> NewInactiveIndexes { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> ReactivatedIndexes { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> InactiveIndexesSample { get; set; } = Array.Empty<string>();
    public bool InactiveIndexesTruncated { get; set; }
    public bool FirstSnapshot { get; set; }
    public DateTimeOffset? PreviousCheckedAt { get; set; }
    public string? Error { get; set; }
}

internal static class StringExtensions
{
    public static string? NullIfWhiteSpace(this string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
