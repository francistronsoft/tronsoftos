using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace TronSoft.Agent.Windows.Services;

public sealed class ServerMetricsCollector
{
    public async Task<ServerMetrics> CollectAsync(CancellationToken cancellationToken)
    {
        var drives = DriveInfo.GetDrives()
            .Where(drive => drive.IsReady && drive.DriveType == DriveType.Fixed)
            .Select(drive => new DriveMetric(
                drive.Name,
                drive.DriveFormat,
                drive.TotalSize,
                drive.AvailableFreeSpace,
                Percent(drive.TotalSize - drive.AvailableFreeSpace, drive.TotalSize)))
            .ToArray();
        var systemDrive = drives.FirstOrDefault(drive => drive.Name.StartsWith(Path.GetPathRoot(Environment.SystemDirectory) ?? "C:", StringComparison.OrdinalIgnoreCase))
                          ?? drives.FirstOrDefault();
        var memory = MemoryStatus();
        var cpuModel = CpuModel();
        var cpuCores = Environment.ProcessorCount;

        return new ServerMetrics(
            Environment.MachineName,
            RuntimeInformation.OSDescription,
            RuntimeInformation.OSArchitecture.ToString(),
            FirstIpv4(),
            Environment.TickCount64 / 1000,
            DateTimeOffset.UtcNow,
            await CpuPercentAsync(cancellationToken),
            cpuModel,
            cpuCores,
            memory,
            systemDrive?.UsedPercent,
            drives);
    }

    private static async Task<double?> CpuPercentAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var counter = new PerformanceCounter("Processor", "% Processor Time", "_Total");
            _ = counter.NextValue();
            await Task.Delay(1_000, cancellationToken);
            return Math.Round(counter.NextValue(), 1);
        }
        catch
        {
            return null;
        }
    }

    private static MemoryMetric MemoryStatus()
    {
        var status = new MEMORYSTATUSEX();
        if (!GlobalMemoryStatusEx(status)) return new MemoryMetric(null, null, null);
        var used = status.ullTotalPhys - status.ullAvailPhys;
        return new MemoryMetric((long)status.ullTotalPhys, (long)status.ullAvailPhys, Percent((long)used, (long)status.ullTotalPhys));
    }

    private static string? CpuModel()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            return key?.GetValue("ProcessorNameString")?.ToString()?.Trim();
        }
        catch
        {
            return null;
        }
    }

    private static string? FirstIpv4()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(item => item.OperationalStatus == OperationalStatus.Up)
            .SelectMany(item => item.GetIPProperties().UnicastAddresses)
            .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address.Address))
            .Select(address => address.Address.ToString())
            .FirstOrDefault();
    }

    private static double Percent(long value, long total)
    {
        return total <= 0 ? 0 : Math.Round(value * 100d / total, 1);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

    [StructLayout(LayoutKind.Sequential)]
    private sealed class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }
}

public sealed record ServerMetrics(
    string Hostname,
    string Os,
    string Architecture,
    string? Ip,
    long UptimeSeconds,
    DateTimeOffset CollectedAt,
    double? CpuPercent,
    string? CpuModel,
    int CpuCores,
    MemoryMetric Memory,
    double? DiskUsedPercent,
    IReadOnlyList<DriveMetric> Disks)
{
    public object ToHostPayload() => new
    {
        hostname = Hostname,
        os = Os,
        architecture = Architecture,
        ip = Ip,
        uptimeSeconds = UptimeSeconds,
        cpuModel = CpuModel,
        cpuName = CpuModel,
        cpuCores = CpuCores,
        processorCount = CpuCores,
        memoryTotalBytes = Memory.TotalBytes,
        ramTotalBytes = Memory.TotalBytes
    };

    public object ToSystemMetricsPayload() => new
    {
        collectedAt = CollectedAt,
        hostUptimeSeconds = UptimeSeconds,
        cpuPercent = CpuPercent,
        memoryPercent = Memory.UsedPercent,
        cpuModel = CpuModel,
        cpuCores = CpuCores,
        memoryTotalBytes = Memory.TotalBytes,
        diskUsedPercent = DiskUsedPercent,
        cpu = new { percent = CpuPercent },
        memory = Memory,
        disk = new { percentUsed = DiskUsedPercent },
        disks = Disks,
        latest = new[]
        {
            new
            {
                collectedAt = CollectedAt,
                cpuPercent = CpuPercent,
                memoryPercent = Memory.UsedPercent,
                cpuModel = CpuModel,
                cpuCores = CpuCores,
                memoryTotalBytes = Memory.TotalBytes,
                diskUsedPercent = DiskUsedPercent,
                hostUptimeSeconds = UptimeSeconds
            }
        }
    };
}

public sealed record MemoryMetric(long? TotalBytes, long? FreeBytes, double? UsedPercent);

public sealed record DriveMetric(string Name, string Format, long TotalBytes, long FreeBytes, double UsedPercent);
