// Unit tests for the SSRF guard used by content-safety media fetches (H3).
import { describe, it, expect } from 'vitest';
import { isPrivateIp, resolvePublicIps, safeFetchBuffer } from '../../utils/ssrf-guard.js';

describe('isPrivateIp', () => {
  it('flags loopback / private / link-local / metadata ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
    expect(isPrivateIp('not-an-ip')).toBe(true); // unparseable → unsafe
  });
});

describe('resolvePublicIps', () => {
  it('rejects IP literals in private/metadata ranges', async () => {
    await expect(resolvePublicIps('169.254.169.254')).rejects.toThrow(/SSRF blocked/);
    await expect(resolvePublicIps('127.0.0.1')).rejects.toThrow(/SSRF blocked/);
  });
  it('accepts a public IP literal', async () => {
    await expect(resolvePublicIps('8.8.8.8')).resolves.toEqual(['8.8.8.8']);
  });
});

describe('safeFetchBuffer', () => {
  it('rejects non-http(s) protocols and private/metadata targets', async () => {
    await expect(safeFetchBuffer('file:///etc/passwd')).rejects.toThrow(/SSRF blocked/);
    await expect(safeFetchBuffer('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/SSRF blocked/);
    await expect(safeFetchBuffer('http://127.0.0.1:6379/')).rejects.toThrow(/SSRF blocked/);
    await expect(safeFetchBuffer('gopher://127.0.0.1/')).rejects.toThrow(/SSRF blocked/);
  });
});
