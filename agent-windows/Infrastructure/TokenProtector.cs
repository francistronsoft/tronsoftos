using System.Security.Cryptography;
using System.Text;

namespace TronSoft.Agent.Windows.Infrastructure;

public sealed class TokenProtector
{
    private readonly AgentPaths _paths;

    public TokenProtector(AgentPaths paths)
    {
        _paths = paths;
    }

    public string? ReadInstallationToken()
    {
        if (!File.Exists(_paths.TokenFile)) return null;
        var protectedBytes = File.ReadAllBytes(_paths.TokenFile);
        var bytes = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.LocalMachine);
        return Encoding.UTF8.GetString(bytes).Trim();
    }

    public void WriteInstallationToken(string token)
    {
        var bytes = Encoding.UTF8.GetBytes(token);
        var protectedBytes = ProtectedData.Protect(bytes, null, DataProtectionScope.LocalMachine);
        File.WriteAllBytes(_paths.TokenFile, protectedBytes);
    }

    public void Reset()
    {
        if (File.Exists(_paths.TokenFile)) File.Delete(_paths.TokenFile);
    }
}
