using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using TronSoft.Agent.Windows;
using TronSoft.Agent.Windows.Infrastructure;
using TronSoft.Agent.Windows.Services;

var paths = AgentPaths.CreateDefault();
paths.Ensure();

var builder = Host.CreateDefaultBuilder(args)
    .UseWindowsService(options => options.ServiceName = "TronSoft Agent Windows")
    .ConfigureAppConfiguration(config =>
    {
        config.AddJsonFile(paths.ConfigFile, optional: true, reloadOnChange: true);
        config.AddEnvironmentVariables("TRONSOFT_AGENT_");
        config.AddCommandLine(args);
    })
    .ConfigureServices((context, services) =>
    {
        services.AddSingleton(paths);
        services.Configure<AgentOptions>(context.Configuration.GetSection("Agent"));
        services.AddHttpClient<CentralClient>();
        services.AddSingleton<TokenProtector>();
        services.AddSingleton<LocalStore>();
        services.AddSingleton<ServerMetricsCollector>();
        services.AddSingleton<ContainerInventoryCollector>();
        services.AddSingleton<FirebirdCollector>();
        services.AddSingleton<BackupCollector>();
        services.AddHostedService<AgentWorker>();
    });

await builder.Build().RunAsync();
