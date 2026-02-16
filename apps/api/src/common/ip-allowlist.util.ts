import { isIP } from "node:net";

function normalizeIp(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  if (trimmed === "::1") {
    return "127.0.0.1";
  }
  return trimmed;
}

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (
    (octets[0] << 24) |
    (octets[1] << 16) |
    (octets[2] << 8) |
    octets[3]
  ) >>> 0;
}

function isIpv4CidrEntry(entry: string): boolean {
  const [baseIpRaw, prefixRaw] = entry.split("/");
  if (!baseIpRaw || !prefixRaw) {
    return false;
  }
  const baseIp = normalizeIp(baseIpRaw);
  if (isIP(baseIp) !== 4) {
    return false;
  }
  const prefix = Number.parseInt(prefixRaw, 10);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function matchesIpv4Cidr(ip: string, cidr: string): boolean {
  const [baseIpRaw, prefixRaw] = cidr.split("/");
  const baseIp = normalizeIp(baseIpRaw);
  const prefix = Number.parseInt(prefixRaw, 10);
  const ipInt = parseIpv4ToInt(ip);
  const baseInt = parseIpv4ToInt(baseIp);
  if (ipInt == null || baseInt == null || Number.isNaN(prefix)) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function isValidIpAllowlistEntry(entry: string): boolean {
  const normalized = normalizeIp(entry);
  if (isIP(normalized) > 0) {
    return true;
  }
  return isIpv4CidrEntry(normalized);
}

export function ipMatchesAllowlist(ipRaw: string, allowlist: string[]): boolean {
  const ip = normalizeIp(ipRaw);
  if (isIP(ip) === 0) {
    return false;
  }
  const normalizedAllowlist = allowlist.map((entry) => normalizeIp(entry)).filter(Boolean);

  for (const entry of normalizedAllowlist) {
    if (entry.includes("/")) {
      if (isIP(ip) === 4 && matchesIpv4Cidr(ip, entry)) {
        return true;
      }
      continue;
    }
    if (entry === ip) {
      return true;
    }
  }
  return false;
}

export function extractClientIp(request: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (headerValue) {
    const first = headerValue.split(",")[0]?.trim();
    if (first) {
      return normalizeIp(first);
    }
  }

  if (request.ip) {
    return normalizeIp(request.ip);
  }

  if (request.socket?.remoteAddress) {
    return normalizeIp(request.socket.remoteAddress);
  }

  return null;
}
