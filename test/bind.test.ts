import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyBind, decideBind, DEFAULT_BIND } from "../src/lib/bind";

/**
 * Bind policy — RVOS-003 P5.
 *
 * `next start` binds 0.0.0.0 by default, so before this policy existed the
 * books were reachable on every network the machine joined. These tests pin
 * the safe default and the two refusals, because the failure they prevent is
 * silent: nothing looks wrong on a laptop that has joined a café network.
 */

test("loopback forms are recognised", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1"]) {
    assert.equal(classifyBind(h), "loopback", h);
  }
});

test("Tailscale's CGNAT range is recognised, and its neighbours are not", () => {
  for (const h of ["100.64.0.1", "100.100.100.100", "100.127.255.255"]) {
    assert.equal(classifyBind(h), "tailscale", h);
  }
  // 100.0-63 and 100.128+ are ordinary public space, NOT the tailnet.
  assert.notEqual(classifyBind("100.63.255.255"), "tailscale");
  assert.notEqual(classifyBind("100.128.0.1"), "tailscale");
});

test("RFC1918 ranges are private, including the 172.16-31 boundary", () => {
  for (const h of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "172.31.255.254", "169.254.1.1"]) {
    assert.equal(classifyBind(h), "private", h);
  }
  // 172.15 and 172.32 are OUTSIDE the private block — a classic off-by-one.
  assert.equal(classifyBind("172.15.0.1"), "other");
  assert.equal(classifyBind("172.32.0.1"), "other");
});

test("wildcard forms all mean every interface", () => {
  for (const h of ["", "0.0.0.0", "::", "*"]) assert.equal(classifyBind(h), "any", `"${h}"`);
});

test("the default is loopback and needs no ceremony", () => {
  const d = decideBind(undefined);
  assert.equal(d.host, DEFAULT_BIND);
  assert.equal(d.kind, "loopback");
  assert.equal(d.refusal, undefined);
  assert.deepEqual(d.warnings, [], "the safe default must not nag");
  // Blank/whitespace env vars fall back rather than becoming a wildcard.
  assert.equal(decideBind("   ").host, DEFAULT_BIND);
  assert.equal(decideBind("").kind, "loopback");
});

test("binding every interface is REFUSED without an explicit override", () => {
  const d = decideBind("0.0.0.0");
  assert.ok(d.refusal, "0.0.0.0 must not be reachable by accident");
  assert.match(d.refusal!, /every network/i);
  assert.match(d.refusal!, /tailscale ip -4/, "tell the operator what to do instead");
  assert.match(d.refusal!, /REVENUEOS_ALLOW_ANY=1/);
});

test("the override works, and still says what it did", () => {
  const d = decideBind("0.0.0.0", { allowAny: true });
  assert.equal(d.refusal, undefined);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /every network/i);
  assert.match(d.warnings[0], /caf|hotel/i, "name the concrete risk, not an abstraction");
});

test("a tailnet address is allowed, with the perimeter stated plainly", () => {
  const d = decideBind("100.101.102.103");
  assert.equal(d.refusal, undefined);
  assert.equal(d.kind, "tailscale");
  assert.match(d.warnings[0], /sign in|login/i, "Tailscale is behind the login, not instead of it");
});

test("a LAN address is REFUSED — café and hotel routers hand out this range", () => {
  // A warning was not enough: the app runs from a Scheduled Task, so nobody
  // reads the console. Exposure to an untrusted LAN has to be deliberate.
  for (const h of ["192.168.1.50", "10.0.0.5", "172.16.4.4", "169.254.1.1"]) {
    const d = decideBind(h);
    assert.ok(d.refusal, `${h} must not bind on a warning alone`);
    assert.match(d.refusal!, /tailscale ip -4/, "point at the supported remote path");
    assert.match(d.refusal!, /REVENUEOS_ALLOW_ANY=1/);
  }
});

test("the LAN override works and still states the exposure", () => {
  const d = decideBind("192.168.1.50", { allowAny: true });
  assert.equal(d.refusal, undefined);
  assert.match(d.warnings[0], /do not\s+control/i);
});

test("an unrecognised or public-looking host is refused", () => {
  for (const h of ["8.8.8.8", "revenueos.example.com", "203.0.113.7"]) {
    const d = decideBind(h);
    assert.ok(d.refusal, `${h} should not bind silently`);
    assert.match(d.refusal!, /public internet|not a loopback/i);
  }
  assert.equal(decideBind("8.8.8.8", { allowAny: true }).refusal, undefined);
});
