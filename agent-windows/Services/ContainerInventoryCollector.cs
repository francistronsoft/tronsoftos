using System.Text.Json;
using System.Security.Principal;

namespace TronSoft.Agent.Windows.Services;

public sealed class ContainerInventoryCollector
{
    public async Task<ContainerInventoryPayload> CollectAsync(CancellationToken cancellationToken)
    {
        var wslInventory = await WslInventoryAsync(cancellationToken);
        if (wslInventory.Available)
        {
            return new ContainerInventoryPayload(
                "windows-wsl",
                DateTimeOffset.UtcNow,
                wslInventory.Containers,
                wslInventory.Detail);
        }

        var direct = await DockerPsAsync("docker.exe", "ps -a --format \"{{json .}}\"", cancellationToken);
        if (direct.Available)
        {
            return new ContainerInventoryPayload("windows-docker", DateTimeOffset.UtcNow, direct.Containers, direct.Detail);
        }

        var wsl = await DockerPsAsync("wsl.exe", "docker ps -a --format \"{{json .}}\"", cancellationToken);
        if (wsl.Available)
        {
            return new ContainerInventoryPayload("windows-wsl-docker", DateTimeOffset.UtcNow, wsl.Containers, wsl.Detail);
        }

        return new ContainerInventoryPayload(
            "windows",
            DateTimeOffset.UtcNow,
            Array.Empty<ContainerStatusPayload>(),
            ShortDetail(
                $"usuario do servico: {CurrentIdentity()}.",
                "Docker/WSL nao disponivel para esta conta.",
                "Se o WSL foi instalado no usuario logado, o servico LocalSystem nao enxerga essas distros.",
                wslInventory.Detail,
                direct.Detail,
                wsl.Detail));
    }

    private static async Task<(bool Available, IReadOnlyList<ContainerStatusPayload> Containers, string? Detail)> WslInventoryAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await Shell.RunAsync("wsl.exe", "-l -v", timeoutMs: 15_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0)
            {
                return (false, Array.Empty<ContainerStatusPayload>(), ShortDetail($"usuario do servico: {CurrentIdentity()}.", result.Stderr, result.Stdout));
            }

            var distros = result.Stdout
                .Replace("\0", "")
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(ParseWslDistro)
                .Where(item => item is not null)
                .Select(item => item!)
                .ToArray();

            if (!distros.Any())
            {
                return (false, Array.Empty<ContainerStatusPayload>(), $"Nenhuma distro WSL encontrada para o usuario do servico ({CurrentIdentity()}).");
            }

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
                containers.AddRange(await WslDockerRowsAsync(distro.Name, cancellationToken));
            }

            var detail = containers.Count == distros.Length
                ? $"WSL disponivel para {CurrentIdentity()}, mas nenhum servico TronSoft/Docker foi encontrado nas distros em execucao."
                : null;
            return (true, containers, detail);
        }
        catch (Exception ex)
        {
            return (false, Array.Empty<ContainerStatusPayload>(), ex.Message);
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

    private static async Task<IReadOnlyList<ContainerStatusPayload>> WslDockerRowsAsync(string distro, CancellationToken cancellationToken)
    {
        var command = "sh -lc \"if command -v docker >/dev/null 2>&1; then docker ps -a --format '{{json .}}'; fi\"";
        try
        {
            var result = await Shell.RunAsync("wsl.exe", $"-d {Quote(distro)} -- {command}", timeoutMs: 20_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0) return Array.Empty<ContainerStatusPayload>();
            return result.Stdout
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => ParseDockerRow(line, distro))
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

    private static async Task<(bool Available, IReadOnlyList<ContainerStatusPayload> Containers, string? Detail)> DockerPsAsync(
        string fileName,
        string arguments,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await Shell.RunAsync(fileName, arguments, timeoutMs: 15_000, cancellationToken: cancellationToken);
            if (result.ExitCode != 0)
            {
                return (false, Array.Empty<ContainerStatusPayload>(), ShortDetail($"{fileName}: exit {result.ExitCode}.", result.Stderr, result.Stdout));
            }

            var containers = result.Stdout
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => ParseDockerRow(line))
                .Where(item => item is not null)
                .Select(item => item!)
                .ToArray();
            var detail = containers.Length == 0 ? $"{fileName} disponivel para {CurrentIdentity()}, mas nenhum container retornado." : null;
            return (true, containers, detail);
        }
        catch (Exception ex)
        {
            return (false, Array.Empty<ContainerStatusPayload>(), $"{fileName}: {ex.Message}");
        }
    }

    private static ContainerStatusPayload? ParseDockerRow(string line, string? source = null)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var name = Text(root, "Names");
            if (string.IsNullOrWhiteSpace(name)) return null;
            var image = Text(root, "Image");
            return new ContainerStatusPayload(
                source is null ? name : $"{source}:{name}",
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

    private static string ShortDetail(params string?[] values)
    {
        var detail = string.Join(" ", values.Where(value => !string.IsNullOrWhiteSpace(value))).Trim();
        return detail.Length > 360 ? detail[..360] : detail;
    }

    private static string CurrentIdentity()
    {
        try
        {
            return WindowsIdentity.GetCurrent().Name;
        }
        catch
        {
            return Environment.UserName;
        }
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
