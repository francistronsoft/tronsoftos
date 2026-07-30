using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;
using TronSoft.Agent.Windows;
using TronSoft.Agent.Windows.Infrastructure;

namespace TronSoft.Agent.Windows.Services;

public sealed class CentralClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly IOptionsMonitor<AgentOptions> _options;
    private readonly LocalStore _store;
    private readonly TokenProtector _tokenProtector;

    public CentralClient(HttpClient http, IOptionsMonitor<AgentOptions> options, LocalStore store, TokenProtector tokenProtector)
    {
        _http = http;
        _options = options;
        _store = store;
        _tokenProtector = tokenProtector;
    }

    public async Task<string> EnsurePairedAsync(object identifyPayload, CancellationToken cancellationToken)
    {
        var existing = _tokenProtector.ReadInstallationToken();
        if (!string.IsNullOrWhiteSpace(existing)) return existing;

        var configuredToken = _options.CurrentValue.PairingToken;
        if (string.IsNullOrWhiteSpace(configuredToken))
        {
            throw new InvalidOperationException("PairingToken nao configurado em C:\\TronSoft\\AgentWindows\\config\\agent.json");
        }

        var payload = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(identifyPayload, JsonOptions), JsonOptions)
                      ?? new Dictionary<string, object?>();
        payload["pairingToken"] = configuredToken.Trim();

        using var response = await _http.PostAsJsonAsync(Url("/api/tronsoftos/pair"), payload, JsonOptions, cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Falha no pareamento: HTTP {(int)response.StatusCode} {responseText}");
        }

        using var json = JsonDocument.Parse(responseText);
        var installationToken = json.RootElement.GetProperty("installationToken").GetString();
        if (string.IsNullOrWhiteSpace(installationToken))
        {
            throw new InvalidOperationException("Central nao retornou installationToken.");
        }

        _tokenProtector.WriteInstallationToken(installationToken);
        if (json.RootElement.TryGetProperty("installationId", out var installationId))
        {
            _store.SetSetting("installationId", installationId.GetString() ?? "");
        }
        _store.AddEvent("PAIR_OK", new { central = _options.CurrentValue.CentralUrl });
        return installationToken;
    }

    public async Task SendHeartbeatAsync(string installationToken, object payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Url("/api/tronsoftos/heartbeat"))
        {
            Content = JsonContent.Create(payload, options: JsonOptions)
        };
        request.Headers.Add("x-installation-token", installationToken);

        using var response = await _http.SendAsync(request, cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Falha no heartbeat: HTTP {(int)response.StatusCode} {responseText}");
        }
    }

    public async Task SendAlertAsync(string installationToken, object alert, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Url("/api/tronsoftos/alerts"))
        {
            Content = JsonContent.Create(alert, options: JsonOptions)
        };
        request.Headers.Add("x-installation-token", installationToken);
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"Falha ao enviar alerta: HTTP {(int)response.StatusCode} {responseText}");
        }
    }

    private Uri Url(string pathname)
    {
        var baseUrl = _options.CurrentValue.CentralUrl.Trim().TrimEnd('/');
        return new Uri($"{baseUrl}{pathname}");
    }
}
