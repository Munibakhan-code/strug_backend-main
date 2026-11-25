// SSRF-safe outbound fetch for URLs that originate from user input (e.g. a campaign's
// media_url). Blocks requests that resolve to private / loopback / link-local ranges —
// including the cloud metadata endpoint 169.254.169.254 — caps size + time, and refuses
// redirects so a public URL cannot bounce to an internal one.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// Is an IP literal in a private / reserved / loopback / link-local range?
export function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;             // this-host / private / loopback
    if (p[0] === 169 && p[1] === 254) return true;                          // link-local incl. metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;             // private
    if (p[0] === 192 && p[1] === 168) return true;                          // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;            // CGNAT
    if (p[0] >= 224) return true;                                           // multicast / reserved
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true;                     // loopback / unspecified
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local / ULA
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a valid IP → treat as unsafe
}

// Resolve a hostname (or accept an IP literal) and return its public IPs, throwing if any
// resolved address is private/reserved. Rejecting when ANY address is private prevents a
// dual-record host from smuggling an internal target.
export async function resolvePublicIps(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('SSRF blocked: private address');
    return [hostname];
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error('SSRF blocked: host does not resolve');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('SSRF blocked: host resolves to a private address');
  }
  return records.map((r) => r.address);
}

// Fetch a URL as a Buffer with SSRF protections. Throws on any unsafe/oversized/redirecting
// response. `axios` is imported lazily to match existing call sites.
export async function safeFetchBuffer(rawUrl, { maxBytes = 10 * 1024 * 1024, timeout = 5000 } = {}) {
  const { default: axios } = await import('axios');

  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('SSRF blocked: invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SSRF blocked: only http(s) is allowed');
  }

  const ips = await resolvePublicIps(url.hostname);

  // Pin the socket to the pre-validated IP so a DNS rebind between our lookup and axios's
  // cannot swap in an internal address. TLS SNI / Host header still use the hostname.
  const lookup = (_host, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, ips[0], net.isIP(ips[0]) || 4);
  };

  const res = await axios.get(url.toString(), {
    responseType: 'arraybuffer',
    maxRedirects: 0,                       // never follow a bounce to an internal host
    timeout,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: (s) => s >= 200 && s < 300, // a 3xx redirect is rejected, not followed
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  });
  return Buffer.from(res.data);
}
