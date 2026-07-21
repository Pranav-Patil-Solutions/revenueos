/**
 * Start RevenueOS with an explicit, checked network bind — RVOS-003 P5.
 *
 *   npm run start                                   # this machine only
 *   REVENUEOS_BIND=100.101.102.103 npm run start    # reachable on the tailnet
 *
 * `next start` binds 0.0.0.0 by default. That is one flag away from serving a
 * client's books on whatever Wi-Fi the machine last joined, and nothing about
 * it looks wrong from the outside. So the bind is decided by src/lib/bind.ts —
 * loopback unless told otherwise, and refusing the dangerous options unless
 * REVENUEOS_ALLOW_ANY=1 is typed out deliberately.
 *
 * Get the tailnet address with:  tailscale ip -4
 */
import { spawn } from "node:child_process";
import { decideBind } from "../src/lib/bind";

const PORT = process.env.PORT ?? "3322";

const decision = decideBind(process.env.REVENUEOS_BIND, {
  allowAny: process.env.REVENUEOS_ALLOW_ANY === "1",
});

if (decision.refusal) {
  console.error(`\n✗ ${decision.refusal}\n`);
  process.exit(1);
}

for (const w of decision.warnings) console.warn(`\n!  ${w}`);

console.log(`\nRevenueOS on http://${decision.host}:${PORT}`);
if (decision.kind === "loopback") {
  console.log("   This machine only. For remote access set REVENUEOS_BIND to");
  console.log("   this machine's Tailscale address (tailscale ip -4).");
} else {
  console.log(`   Phone capture: http://${decision.host}:${PORT}/capture`);
  if (process.env.REVENUEOS_HTTPS !== "1") {
    // The session cookie's Secure flag is off by default precisely because
    // this is plain HTTP. If TLS is ever terminated in front (tailscale
    // serve), REVENUEOS_HTTPS=1 must be set or the cookie stays non-Secure.
    console.log("   Served over plain HTTP. If you put TLS in front of this");
    console.log("   (e.g. `tailscale serve`), also set REVENUEOS_HTTPS=1.");
  }
}
console.log("");

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "start", "-p", PORT, "-H", decision.host],
  { stdio: "inherit", env: process.env }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
