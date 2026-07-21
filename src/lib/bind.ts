/**
 * Network bind policy — RVOS-003 P5.
 *
 * `next start` binds 0.0.0.0 by default: every interface, on every network the
 * machine ever joins. For a laptop that visits a client's office or a café,
 * that is a different proposition from "reachable on the tailnet", and the
 * difference is invisible in a port number.
 *
 * So the bind is explicit here, defaults to loopback, and REFUSES the
 * dangerous options unless someone says so out loud. Tailscale is defence in
 * depth BEHIND the login (RVOS-003 P2) — never the perimeter itself, which is
 * what it used to be.
 *
 * Pure and injected-free so the policy is unit tested rather than discovered
 * on the office machine.
 */

export type BindKind = "loopback" | "tailscale" | "private" | "any" | "other";

export const DEFAULT_BIND = "127.0.0.1";

/** Tailscale hands out CGNAT addresses from 100.64.0.0/10 (RFC 6598). */
function isTailscale(host: string): boolean {
  const m = host.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function isPrivate(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export function classifyBind(host: string): BindKind {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return "loopback";
  }
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "*") return "any";
  if (isTailscale(h)) return "tailscale";
  if (isPrivate(h)) return "private";
  return "other";
}

export interface BindDecision {
  host: string;
  kind: BindKind;
  /** Set = do not start. Explains what would have been exposed. */
  refusal?: string;
  /** Start, but the operator should understand these. */
  warnings: string[];
}

/**
 * Decide what to bind.
 *
 * `requested` is REVENUEOS_BIND. `allowAny` is REVENUEOS_ALLOW_ANY=1 — a
 * deliberate, typed-out override, because the failure it guards against
 * (exposing a client's books on a café network) is silent and undoable.
 */
export function decideBind(
  requested: string | undefined,
  opts: { allowAny?: boolean } = {}
): BindDecision {
  const host = (requested ?? DEFAULT_BIND).trim() || DEFAULT_BIND;
  const kind = classifyBind(host);
  const warnings: string[] = [];

  switch (kind) {
    case "loopback":
      return { host, kind, warnings };

    case "tailscale":
      warnings.push(
        `Bound to the tailnet address ${host}. Every device on your Tailscale ` +
          `network can now reach the books — they still need to sign in, and the ` +
          `login is the only thing in the way. Keep the tailnet small.`
      );
      return { host, kind, warnings };

    case "private":
      // REFUSED, not merely warned. Café, hotel and home routers hand out
      // exactly these ranges, which is the scenario this module exists to
      // prevent — and a warning printed to a console nobody watches (the app
      // runs from a Scheduled Task) is not the deliberate override the design
      // claims to require. Tailscale addresses are the supported remote path.
      return opts.allowAny
        ? {
            host,
            kind,
            warnings: [
              `Bound to the local network address ${host}. Anything on that Wi-Fi ` +
                `or office LAN can reach the books, including devices you do not ` +
                `control. This was explicitly allowed via REVENUEOS_ALLOW_ANY=1.`,
            ],
          }
        : {
            host,
            kind,
            warnings: [],
            refusal:
              `Refusing to bind the local network address ${host}.\n` +
              `  Café, hotel and home routers all hand out addresses in this range,\n` +
              `  so this can expose the books to devices you do not control.\n` +
              `  For remote access use this machine's Tailscale address\n` +
              `  (run: tailscale ip -4). If you really mean the local network,\n` +
              `  set REVENUEOS_ALLOW_ANY=1 as well.`,
          };

    case "any":
      return opts.allowAny
        ? {
            host: host || "0.0.0.0",
            kind,
            warnings: [
              `Bound to EVERY network interface. The books are reachable on every ` +
                `network this machine joins from now on — including hotel and café ` +
                `Wi-Fi. This was explicitly allowed via REVENUEOS_ALLOW_ANY=1.`,
            ],
          }
        : {
            host,
            kind,
            warnings: [],
            refusal:
              `Refusing to bind every interface (${host || "0.0.0.0"}).\n` +
              `  That exposes the books on every network this machine ever joins.\n` +
              `  For remote access set REVENUEOS_BIND to this machine's Tailscale\n` +
              `  address (run: tailscale ip -4). If you genuinely want all\n` +
              `  interfaces, set REVENUEOS_ALLOW_ANY=1 as well.`,
          };

    case "other":
      return opts.allowAny
        ? { host, kind, warnings: [`Bound to ${host}, which is neither loopback, tailnet nor a private LAN address.`] }
        : {
            host,
            kind,
            warnings: [],
            refusal:
              `Refusing to bind "${host}" — it is not a loopback or Tailscale\n` +
              `  address, so it may be reachable from the public internet. Use\n` +
              `  this machine's Tailscale address (run: tailscale ip -4), or set\n` +
              `  REVENUEOS_ALLOW_ANY=1 if you are certain.`,
          };
  }
}
