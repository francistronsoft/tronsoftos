namespace TronSoft.Agent.Windows;

public sealed class AgentOptions
{
    public string CentralUrl { get; set; } = "https://central.tronsoft.app.br";
    public string PairingToken { get; set; } = "";
    public string InstallationId { get; set; } = "";
    public string EnvironmentName { get; set; } = "Servidor Windows";
    public string ServerAlias { get; set; } = "SERVIDOR";
    public int HeartbeatIntervalSeconds { get; set; } = 60;
    public FirebirdOptions Firebird { get; set; } = new();
    public BackupOptions Backups { get; set; } = new();
}

public sealed class FirebirdOptions
{
    public bool Enabled { get; set; } = true;
    public string Alias { get; set; } = "";
    public string DatabasePath { get; set; } = @"C:\ERP_TRONSOFT\ERP_TRONSOFT.FDB";
    public string Host { get; set; } = "localhost";
    public string User { get; set; } = "SYSDBA";
    public string Password { get; set; } = "masterkey";
    public string IsqlPath { get; set; } = "";
    public int QueryTimeoutSeconds { get; set; } = 20;
}

public sealed class BackupOptions
{
    public string Directory { get; set; } = @"C:\ERP_TRONSOFT\BACKUP";
    public int MaxAgeHours { get; set; } = 24;
}
