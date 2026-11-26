import test from 'node:test';
import assert from 'node:assert/strict';
import { googleDriveErrorDetails } from './google-drive-errors.mjs';

test('explicit disabled API reasons are recognized and preserve activation URL', () => {
  for (const reason of ['SERVICE_DISABLED', 'accessNotConfigured', 'Google Drive API has not been used in project 123 before or it is disabled', 'Google Drive API is disabled']) {
    const result = googleDriveErrorDetails(new Error(reason));
    assert.equal(result.code, 'google_drive_api_disabled');
  }
  const activationUrl = 'https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123';
  assert.equal(googleDriveErrorDetails(new Error(`SERVICE_DISABLED ${activationUrl}`)).activationUrl, activationUrl);
});

test('Drive endpoint in a network, permission or quota error does not mean disabled API', () => {
  for (const raw of [
    'Get https://drive.googleapis.com/drive/v3/about: dial tcp: lookup drive.googleapis.com: no such host',
    'Get https://drive.googleapis.com/drive/v3/about: context deadline exceeded',
    'https://drive.googleapis.com: Error 403: insufficientPermissions',
    'https://drive.googleapis.com: Error 429: rateLimitExceeded',
    'https://drive.googleapis.com: Error 500: backendError'
  ]) {
    const result = googleDriveErrorDetails(new Error(raw));
    assert.equal(result.code, 'google_drive_error');
    assert.equal(result.message, raw);
  }
});

test('Drive URL does not mask expired authorization or missing IPv6 route', () => {
  assert.equal(googleDriveErrorDetails(new Error('https://drive.googleapis.com: invalid_grant')).code, 'google_drive_auth_expired');
  assert.equal(googleDriveErrorDetails(new Error('Get https://drive.googleapis.com: dial tcp [2607:f8b0::1]:443: network is unreachable')).code, 'google_drive_ipv6_unreachable');
});
