'use strict';

// Unit tests for the SSRF egress guard. Literal-IP cases need no DNS, so they
// run offline. NODE_ENV is forced to 'production' so the loopback dev-allowance
// is off and the real blocking policy is exercised.

const ORIGINAL_ENV = process.env.NODE_ENV;

describe('ssrfGuard', () => {
  let guard;
  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.SSRF_ALLOW_LOOPBACK;
    guard = require('../src/core/lib/ssrfGuard');
  });
  afterAll(() => { process.env.NODE_ENV = ORIGINAL_ENV; });

  describe('ipIsPublic', () => {
    const blocked = [
      '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0', '255.255.255.255', '224.0.0.1', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
    ];
    const allowed = ['8.8.8.8', '1.1.1.1', '52.1.2.3', '2606:4700:4700::1111'];

    test.each(blocked)('blocks %s', (ip) => {
      expect(guard.ipIsPublic(ip)).toBe(false);
    });
    test.each(allowed)('allows %s', (ip) => {
      expect(guard.ipIsPublic(ip)).toBe(true);
    });
  });

  describe('assertPublicUrl', () => {
    test('rejects non-http(s) schemes', async () => {
      await expect(guard.assertPublicUrl('file:///etc/passwd')).rejects.toThrow(guard.SsrfBlockedError);
      await expect(guard.assertPublicUrl('gopher://x')).rejects.toThrow();
    });
    test('rejects http:// in production', async () => {
      await expect(guard.assertPublicUrl('http://example.com')).rejects.toThrow(guard.SsrfBlockedError);
    });
    test('rejects literal private/metadata IPs without DNS', async () => {
      await expect(guard.assertPublicUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(guard.SsrfBlockedError);
      await expect(guard.assertPublicUrl('https://127.0.0.1:8080/x')).rejects.toThrow();
      await expect(guard.assertPublicUrl('https://[::1]/x')).rejects.toThrow();
      await expect(guard.assertPublicUrl('https://10.0.0.9/internal')).rejects.toThrow();
    });
    test('rejects malformed URL', async () => {
      await expect(guard.assertPublicUrl('not a url')).rejects.toThrow(guard.SsrfBlockedError);
    });
    test('allows a literal public IP', async () => {
      await expect(guard.assertPublicUrl('https://8.8.8.8/')).resolves.toBeTruthy();
    });
  });
});
