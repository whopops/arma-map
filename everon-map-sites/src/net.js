// IP address helpers: what bans, rate limits and lockouts count by, and the admin allow-list.

// Parses an IPv4 or IPv6 address into { v: 4|6, bytes: Uint8Array }, or null.
export function parseIp(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  const v4 = parseV4(s);
  if (v4) return { v: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  // An IPv4 address written as IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address.
  if (v6.slice(0, 10).every(b => b === 0) && v6[10] === 0xff && v6[11] === 0xff) return { v: 4, bytes: v6.slice(12) };
  return { v: 6, bytes: v6 };
}

function parseV4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i]) || +parts[i] > 255) return null;
    out[i] = +parts[i];
  }
  return out;
}

function parseV6(s) {
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.split('%')[0];
  if (!/^[0-9a-fA-F:.]+$/.test(s) || (s.match(/::/g) || []).length > 1) return null;
  if (s.includes('.')) { // a trailing IPv4 part becomes its two hex groups
    const lastColon = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const group = g => /^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN;
  let groups;
  if (s.includes('::')) {
    const [a, b] = s.split('::');
    const head = a ? a.split(':').map(group) : [];
    const rest = b ? b.split(':').map(group) : [];
    if (head.length + rest.length >= 8) return null;
    groups = [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest];
  } else {
    groups = s.split(':').map(group);
  }
  if (groups.length !== 8 || groups.some(g => Number.isNaN(g))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[2 * i] = g >> 8; out[2 * i + 1] = g & 0xff; });
  return out;
}

function fmtV6(bytes) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((bytes[i] << 8) | bytes[i + 1]);
  // Longest run of two or more zero groups becomes "::", as Python's ipaddress writes it.
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map(x => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

export function fmtIp(ip) {
  return ip.v === 4 ? [...ip.bytes].join('.') : fmtV6(ip.bytes);
}

// The address, or for IPv6 its /64, since one home or phone gets a whole /64 and can pick any address in it.
export function addrKey(s) {
  const ip = parseIp(s);
  if (!ip) return String(s);
  if (ip.v === 4) return fmtIp(ip);
  const net = ip.bytes.slice();
  net.fill(0, 8);
  return `${fmtV6(net)}/64`;
}

// Parses "1.2.3.4", "10.0.0.0/8" or "2001:db8::/32" into { v, bytes, bits }; throws on nonsense.
export function parseNet(s) {
  const [addr, len] = s.trim().split('/');
  const ip = parseIp(addr);
  if (!ip) throw new Error(`${s} is not an address or network`);
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`${s} has a bad prefix length`);
  return { v: ip.v, bytes: ip.bytes, bits };
}

export function inNet(ip, net) {
  if (ip.v !== net.v) return false;
  for (let bit = 0; bit < net.bits; bit++) {
    const i = bit >> 3, m = 0x80 >> (bit & 7);
    if ((ip.bytes[i] & m) !== (net.bytes[i] & m)) return false;
  }
  return true;
}
