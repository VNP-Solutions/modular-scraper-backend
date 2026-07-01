import dns from "node:dns";

let configured = false;

/**
 * Pin the DNS resolver used for `mongodb+srv://` SRV lookups.
 *
 * `mongodb+srv://` makes the driver perform a DNS SRV query via Node's c-ares
 * resolver. That resolver reads the OS DNS server list and can fail with
 * `querySrv ECONNREFUSED` when it targets a stale / VPN / IPv6 DNS server that
 * refuses the query — even when `nslookup` and normal socket connections work
 * (those use the OS getaddrinfo resolver, not c-ares).
 *
 * Pinning known-good resolvers makes the SRV lookup succeed. Override with the
 * `DNS_SERVERS` env var (comma-separated) in environments that must use an
 * internal resolver; set it empty to keep the system defaults.
 */
export function configureDnsServers(): void {
  if (configured) return;
  configured = true;

  const raw = process.env.DNS_SERVERS ?? "8.8.8.8,1.1.1.1,8.8.4.4";
  const servers = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (servers.length === 0) return;

  try {
    dns.setServers(servers);
    console.log(`DNS resolver pinned to: ${servers.join(", ")}`);
  } catch (err) {
    console.error(
      "Failed to set DNS servers; falling back to system defaults:",
      err
    );
  }
}
