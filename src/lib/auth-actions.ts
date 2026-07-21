"use server";

import { redirect } from "next/navigation";
import { getDb } from "./db";
import {
  authenticate,
  createSession,
  createUser,
  destroySession,
  passwordProblem,
  safeNextPath,
  userCount,
} from "./auth";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "./session";

/**
 * Auth server actions — RVOS-003 P2.
 *
 * These three live apart from lib/actions.ts on purpose: every action in THAT
 * file requires a session, and these are the only ones that must run without
 * one. Keeping them separate means the rule for actions.ts stays absolute
 * ("every export starts with requireSession()"), which is a rule a reviewer
 * can actually check by eye.
 *
 * Server Functions are POSTs to whatever route uses them — they are NOT
 * covered by the proxy matcher in any dependable way (a refactor that moves an
 * action to another route silently removes coverage). So authorization is
 * decided here, not upstream.
 */

/** Only the SHAPE of the failure is returned. "No such user" and "wrong
 * password" are deliberately indistinguishable — the login form must not
 * double as a staff directory. */
export type LoginState = { error: string } | null;

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Enter a username and password." };

  const now = new Date();
  const outcome = authenticate(getDb(), username, password, now.toISOString());

  if (!outcome.ok) {
    if (outcome.reason === "locked") {
      return {
        error:
          "Too many failed attempts. This account is locked for 15 minutes — " +
          "the lock survives a restart, so waiting is the only way through.",
      };
    }
    return { error: "Wrong username or password." };
  }

  const token = createSession(getDb(), outcome.user_id, now.toISOString());
  await setSessionCookie(token, now);
  redirect(safeNextPath(formData.get("next")));
}

export async function logout(): Promise<void> {
  destroySession(getDb(), await readSessionToken());
  await clearSessionCookie();
  redirect("/login");
}

/**
 * First-run bootstrap: create the office's first account.
 *
 * Guarded on there being NO users at all, so it can only ever run once. This
 * is why the app ships with no default password — a seeded "admin/admin" that
 * someone forgets to change is worse than no auth at all, because it looks
 * secure.
 */
export async function createFirstUser(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const db = getDb();
  if (userCount(db) > 0) return { error: "An account already exists. Sign in instead." };

  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!username) return { error: "Choose a username." };
  if (password !== confirm) return { error: "The two passwords do not match." };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };

  const now = new Date();
  const id = createUser(db, username, password, now.toISOString());
  const token = createSession(db, id, now.toISOString());
  await setSessionCookie(token, now);
  redirect("/");
}
