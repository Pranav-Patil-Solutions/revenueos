import type { Capability, Role } from "./types";

/**
 * Who may do what — RVOS-006 P0b.
 *
 * Pure data plus one predicate, deliberately: authorization that lives in a
 * table can be read and audited in one screenful, whereas authorization spread
 * across `if (user.role === "owner" || ...)` checks at each call site is
 * something nobody can state the current shape of. `dal.ts` is the only place
 * that ENFORCES this (it is the real authorization boundary — see its
 * docstring on why layouts and the proxy are not); this module only decides.
 *
 * The capabilities are cut by CONSEQUENCE, not by screen:
 *
 * - `entry.stage` vs `entry.post` is the important line. Staging is reversible
 *   — a captured photo, an imported CSV, an edited draft row changes nothing
 *   in the books and can be deleted. Posting is not: it writes immutable
 *   journals, and this app has no void (until RVOS-007 P10), so a clerk who
 *   can post can permanently misstate a client's accounts. Those are not the
 *   same trust.
 * - `books.lock` is separate from posting because locking a period takes
 *   away everyone else's ability to correct it.
 * - `company.manage` covers a client's tax identity (GSTIN, PAN, regime).
 *   Wrong values there silently corrupt every return the app prepares, so it
 *   is an owner decision even though it looks like a settings form.
 */

export const ROLES: readonly Role[] = ["owner", "accountant", "clerk", "viewer"];

const CAPABILITIES: Record<Role, readonly Capability[]> = {
  // The firm's principal. Everything, including who else gets in.
  owner: [
    "book.read",
    "entry.stage",
    "entry.post",
    "books.lock",
    "accounts.manage",
    "company.manage",
    "users.manage",
  ],
  // Keeps the books and signs off the year: may post and lock, and may shape
  // the chart of accounts. May NOT change a client's tax identity or add staff.
  accountant: [
    "book.read",
    "entry.stage",
    "entry.post",
    "books.lock",
    "accounts.manage",
  ],
  // Does the data entry: captures, imports, corrects drafts. Everything a
  // clerk does is reversible until an accountant posts it.
  clerk: ["book.read", "entry.stage"],
  // Reads statements. The client themself, or an auditor mid-review.
  viewer: ["book.read"],
};

/** Every capability this role holds — for rendering a role's description. */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return CAPABILITIES[role] ?? [];
}

export function can(role: Role, capability: Capability): boolean {
  return capabilitiesOf(role).includes(capability);
}

/** Human labels for the settings screen. */
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  accountant: "Accountant",
  clerk: "Clerk",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Everything, including staff and each client's tax identity.",
  accountant: "Post entries, lock periods, manage the chart of accounts.",
  clerk: "Capture, import and correct drafts. Cannot post to the books.",
  viewer: "Read statements only. Changes nothing.",
};

/** Why an action was refused, phrased for the person who was refused. */
export function refusalMessage(role: Role, capability: Capability): string {
  const needed: Role[] = ROLES.filter((r) => can(r, capability));
  return (
    `Your role (${ROLE_LABEL[role]}) cannot do this. ` +
    `It needs: ${needed.map((r) => ROLE_LABEL[r]).join(" or ")}.`
  );
}
