// A Drive hostname alone does not establish that its API is disabled.
export function googleDriveErrorDetails(error) {
  const raw = String(error?.message || error || 'Falha ao acessar Google Drive');
  const activationUrl = raw.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/drive\.googleapis\.com\/overview\?project=\d+/)?.[0] || '';
  if (/\bSERVICE_DISABLED\b|\baccessNotConfigured\b|Google Drive API has not been used|Google Drive API (?:is|has been) disabled/i.test(raw)) {
    return {
      code: 'google_drive_api_disabled',
      activationUrl,
      message: activationUrl
        ? `Google Drive API desativada no projeto Google. Habilite em ${activationUrl} e aguarde alguns minutos antes de testar novamente.`
        : 'Google Drive API desativada no projeto Google das credenciais OAuth da Central. Habilite a API e aguarde alguns minutos antes de testar novamente.'
    };
  }
  if (/invalid_grant|refresh token|Token has been expired|revoked/i.test(raw)) {
    return {
      code: 'google_drive_auth_expired',
      activationUrl: '',
      message: 'Autorizacao do Google Drive expirou ou foi revogada. Reautorize o Google Drive. Se o client OAuth estiver em Producao, confira revogacao manual, limite de refresh tokens do Google ou troca de grant pela mesma conta.'
    };
  }
  if (/network is unreachable|dial tcp \[[0-9a-f:]+\]:443/i.test(raw)) {
    return {
      code: 'google_drive_ipv6_unreachable',
      activationUrl: '',
      message: 'Servidor tentou acessar o Google Drive por IPv6, mas a rede nao possui rota IPv6. O TronSoftOS deve executar o rclone com IPv4 (--bind 0.0.0.0) ou o IPv6 deve ser desativado/corrigido no Debian.'
    };
  }
  return { code: 'google_drive_error', activationUrl: '', message: raw };
}
