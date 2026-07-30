using System.Text.Json;

namespace TronSoft.Agent.Windows.Services;

public sealed class ContainerInventoryCollector
{
    public async Task<ContainerInventoryPayload> CollectAsync(CancellationToken cancellationToken)
    {
        var wslInventory = await WslInventoryAsync(cancellationToken);
        if (wslInventory.Available)
        {
            return new ContainerInventoryPayload("windows-wsl", DateTimeOffset.UtcNow, wslInventory.Containers, null);
        }

        var direct = await DockerPsAsync("docker.exe", "ps -a --format \"{{json .}}\"", cancellationToken);
        if (direct.Available)
        {
            return new ContainerInventoryPayload("windows-docker", DateTimeOffset.UtcNow, direct.Containers, null);
        }

        var wsl = await DockerPsAsync("wsl.exe", "docker ps -a --format \"{{json .}}\"", cancellationToken);
        if (wsl.Available)
        {
            return new ContainerInventoryPayload("windows-wsl-docker", DateTimeOffset.UtcNow, wsl.Containers, null);
        }

        return new ContainerInventoryPayload("windows", DateTimeOffset.UtcNow, Array.Empty<ContainerStatusPayload>(), "Docker/WSL nao disponivel");
    }

    private static async Task<(bool Available, IReadOnlyList<ContainerStatusPayload> Containers)> WslInventoryAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await Shell.RunAsync("wsl.exe", "-l -v", timeoutMs: 15_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0) return (false, Array.Empty<ContainerStatusPayload>());

            var distros = result.Stdout
                .Replace("\0", "")
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(ParseWslDistro)
                .Where(item => item is not null)
                .Select(item => item!)
                .ToArray();

            if (!distros.Any()) return (false, Array.Empty<ContainerStatusPayload>());

            var containers = new List<ContainerStatusPayload>();
            containers.AddRange(distros.Select(distro => new ContainerStatusPayload(
                $"wsl:{distro.Name}",
                WslStatus(distro.State),
                distro.State,
                "WSL",
                distro.Version,
                "")));

            foreach (var distro in distros.Where(item => string.Equals(item.State, "Running", StringComparison.OrdinalIgnoreCase)))
            {
                containers.AddRange(await WslServiceRowsAsync(distro.Name, cancellationToken));
            }

            return (true, containers);
        }
        catch
        {
            return (false, Array.Empty<ContainerStatusPayload>());
        }
    }

    private static WslDistro? ParseWslDistro(string line)
    {
        var clean = line.Trim().TrimStart('*').Trim();
        if (clean.Length == 0 || clean.StartsWith("NAME", StringComparison.OrdinalIgnoreCase)) return null;

        var parts = clean.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3) return null;
        return new WslDistro(parts[0], parts[1], parts[2]);
    }

    private static async Task<IReadOnlyList<ContainerStatusPayload>> WslServiceRowsAsync(string distro, CancellationToken cancellationToken)
    {
        var command = "sh -lc \"if command -v systemctl >/dev/null 2>&1; then systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | grep -Ei 'tron|retaguarda|comanda|firebird|postgres|nginx|redis' || true; fi\"";
        try
        {
            var result = await Shell.RunAsync("wsl.exe", $"-d {Quote(distro)} -- {command}", timeoutMs: 15_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0) return Array.Empty<ContainerStatusPayload>();
            return result.Stdout
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => ParseWslService(distro, line))
                .Where(item => item is not null)
                .Select(item => item!)
                .ToArray();
        }
        catch
        {
            return Array.Empty<ContainerStatusPayload>();
        }
    }

    private static ContainerStatusPayload? ParseWslService(string distro, string line)
    {
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 4) return null;
        var unit = parts[0];
        var active = parts.Length > 2 ? parts[2] : "unknown";
        return new ContainerStatusPayload(
            $"{distro}:{unit}",
            active.Equals("active", StringComparison.OrdinalIgnoreCase) ? "running" : active.ToLowerInvariant(),
            string.Join(' ', parts.Skip(1).Take(4)),
            "WSL service",
            "",
            "");
    }

    private static string WslStatus(string state)
    {
        return state.Equals("Running", StringComparison.OrdinalIgnoreCase) ? "running" : "stopped";
    }

    private static async Task<(bool Available, IReadOnlyList<ContainerStatusPayload> Containers)> DockerPsAsync(
        string fileName,
        string arguments,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await Shell.RunAsync(fileName, arguments, timeoutMs: 15_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0) return (false, Array.Empty<ContainerStatusPayload>());

            var containers = result.Stdout
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(ParseDockerRow)
                .Where(item => item is not null)
                .Select(item => item!)
                .ToArray();
            return (true, containers);
        }
        catch
        {
            return (false, Array.Empty<ContainerStatusPayload>());
        }
    }

    private static ContainerStatusPayload? ParseDockerRow(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var name = Text(root, "Names");
            if (string.IsNullOrWhiteSpace(name)) return null;
            var image = Text(root, "Image");
            return new ContainerStatusPayload(
                name,
                Text(root, "State", "unknown").ToLowerInvariant(),
                Text(root, "Status"),
                image,
                ImageTag(image),
                Text(root, "ID"));
        }
        catch
        {
            return null;
        }
    }

    private static string Text(JsonElement root, string property, string fallback = "")
    {
        return root.TryGetProperty(property, out var value) ? value.GetString() ?? fallback : fallback;
    }

    private static string ImageTag(string image)
    {
        var index = image.LastIndexOf(':');
        return index >= 0 && index < image.Length - 1 ? image[(index + 1)..] : "";
    }

    private static string Quote(string value)
    {
        return $"\"{value.Replace("\"", "\\\"")}\"";
    }

    private sealed record WslDistro(string Name, string State, string Version);
}

public sealed record ContainerInventoryPayload(
    string Platform,
    DateTimeOffset CollectedAt,
    IReadOnlyList<ContainerStatusPayload> Containers,
    string? Detail);

public sealed record ContainerStatusPayload(
    string Name,
    string Status,
    string Detail,
    string Image,
    string ImageTag,
    string ImageId);
