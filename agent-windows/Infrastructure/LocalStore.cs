using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace TronSoft.Agent.Windows.Infrastructure;

public sealed class LocalStore
{
    private readonly AgentPaths _paths;

    public LocalStore(AgentPaths paths)
    {
        _paths = paths;
        Initialize();
    }

    public string? GetSetting(string key)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "select value from settings where key = $key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string;
    }

    public void SetSetting(string key, string value)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            insert into settings(key, value, updated_at)
            values($key, $value, $updatedAt)
            on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
            """;
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        command.Parameters.AddWithValue("$updatedAt", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    public void EnqueueHeartbeat(object payload)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "insert into heartbeat_queue(payload, created_at) values($payload, $createdAt)";
        command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(payload));
        command.Parameters.AddWithValue("$createdAt", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<QueuedHeartbeat> GetQueuedHeartbeats(int limit = 20)
    {
        var items = new List<QueuedHeartbeat>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "select id, payload from heartbeat_queue order by id limit $limit";
        command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            items.Add(new QueuedHeartbeat(reader.GetInt64(0), reader.GetString(1)));
        }
        return items;
    }

    public void DeleteQueuedHeartbeat(long id)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "delete from heartbeat_queue where id = $id";
        command.Parameters.AddWithValue("$id", id);
        command.ExecuteNonQuery();
    }

    public void AddEvent(string type, object details)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "insert into events(type, details, created_at) values($type, $details, $createdAt)";
        command.Parameters.AddWithValue("$type", type);
        command.Parameters.AddWithValue("$details", JsonSerializer.Serialize(details));
        command.Parameters.AddWithValue("$createdAt", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    public IndexSnapshotRecord? GetLatestIndexSnapshot(string databasePath)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            select database_path, total_indexes, active_indexes, inactive_indexes, inactive_names_json, created_at
            from index_snapshots
            where database_path = $databasePath
            order by id desc
            limit 1
            """;
        command.Parameters.AddWithValue("$databasePath", databasePath);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;

        return new IndexSnapshotRecord(
            reader.GetString(0),
            reader.GetInt32(1),
            reader.GetInt32(2),
            reader.GetInt32(3),
            JsonSerializer.Deserialize<string[]>(reader.GetString(4)) ?? Array.Empty<string>(),
            DateTimeOffset.Parse(reader.GetString(5)));
    }

    public void AddIndexSnapshot(IndexSnapshotRecord snapshot)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            insert into index_snapshots(database_path, total_indexes, active_indexes, inactive_indexes, inactive_names_json, created_at)
            values($databasePath, $totalIndexes, $activeIndexes, $inactiveIndexes, $inactiveNamesJson, $createdAt)
            """;
        command.Parameters.AddWithValue("$databasePath", snapshot.DatabasePath);
        command.Parameters.AddWithValue("$totalIndexes", snapshot.TotalIndexes);
        command.Parameters.AddWithValue("$activeIndexes", snapshot.ActiveIndexes);
        command.Parameters.AddWithValue("$inactiveIndexes", snapshot.InactiveIndexes);
        command.Parameters.AddWithValue("$inactiveNamesJson", JsonSerializer.Serialize(snapshot.InactiveNames));
        command.Parameters.AddWithValue("$createdAt", snapshot.CreatedAt.ToString("O"));
        command.ExecuteNonQuery();
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection($"Data Source={_paths.DatabaseFile}");
        connection.Open();
        return connection;
    }

    private void Initialize()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            create table if not exists settings (
              key text primary key,
              value text not null,
              updated_at text not null
            );
            create table if not exists heartbeat_queue (
              id integer primary key autoincrement,
              payload text not null,
              created_at text not null
            );
            create table if not exists events (
              id integer primary key autoincrement,
              type text not null,
              details text not null,
              created_at text not null
            );
            create table if not exists index_snapshots (
              id integer primary key autoincrement,
              database_path text not null,
              total_indexes integer not null,
              active_indexes integer not null,
              inactive_indexes integer not null,
              inactive_names_json text not null,
              created_at text not null
            );
            create index if not exists idx_heartbeat_queue_created on heartbeat_queue(created_at);
            create index if not exists idx_events_created on events(created_at);
            create index if not exists idx_index_snapshots_database_created on index_snapshots(database_path, created_at);
            """;
        command.ExecuteNonQuery();
    }
}

public sealed record QueuedHeartbeat(long Id, string Payload);
public sealed record IndexSnapshotRecord(
    string DatabasePath,
    int TotalIndexes,
    int ActiveIndexes,
    int InactiveIndexes,
    IReadOnlyList<string> InactiveNames,
    DateTimeOffset CreatedAt);
