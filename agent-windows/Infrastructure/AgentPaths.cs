namespace TronSoft.Agent.Windows.Infrastructure;

public sealed class AgentPaths
{
    public string Root { get; init; } = @"C:\TronSoft\AgentWindows";
    public string ConfigDir => Path.Combine(Root, "config");
    public string DataDir => Path.Combine(Root, "data");
    public string LogsDir => Path.Combine(Root, "logs");
    public string CacheDir => Path.Combine(Root, "cache");
    public string ConfigFile => Path.Combine(ConfigDir, "agent.json");
    public string TokenFile => Path.Combine(ConfigDir, "token.sec");
    public string DatabaseFile => Path.Combine(DataDir, "agent.db");
    public string LastHeartbeatFile => Path.Combine(CacheDir, "last-heartbeat.json");

    public static AgentPaths CreateDefault() => new();

    public void Ensure()
    {
        Directory.CreateDirectory(ConfigDir);
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(LogsDir);
        Directory.CreateDirectory(CacheDir);
    }
}
