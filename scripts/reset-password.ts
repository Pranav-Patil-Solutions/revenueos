/**
 * Reset a user's password from the machine that holds the books.
 *
 *   npm run reset-password -- --list
 *   npm run reset-password -- --user PRANAV
 *
 * ── Why this exists ──
 * There is no password-reset e-mail (docs/DAY-ONE.md is explicit about that:
 * this machine has no mail server and no cloud account behind it), and
 * `changePassword` in src/lib/auth.ts had no caller — no Settings screen, no
 * script. A forgotten owner password therefore locked the office out of its
 * own books with no route back in. This is that route.
 *
 * ── Why it is not a security hole ──
 * It grants nothing that possession of `data/revenueos.db` did not already
 * grant: anyone who can run this can already read every table with `sqlite3`.
 * The perimeter for a local-first app is the machine and the tailnet, not the
 * login form. What the login form protects against is a REMOTE reader over
 * Tailscale, and this script is not reachable remotely.
 *
 * ── Guard rails ──
 * - The new password is TYPED, never passed as an argument or an environment
 *   variable. An argv password lands in shell history and in `ps` output for
 *   every other user on the machine; an env var lands in the environment of
 *   every child process. Neither is worth the convenience.
 * - A verified backup is taken BEFORE the write, same as `npm run migrate`.
 * - Every session for that user is destroyed (changePassword does this), so a
 *   cookie issued under the old password stops working immediately.
 * - The reset is written to `audit_log` with a NULL actor — the schema
 *   reserves NULL for exactly this, an action with no signed-in user.
 *
 * Unlike `npm run restore`, this does NOT require stopping the app: it is an
 * ordinary single-row write, and WAL mode is built for a second writer.
 */
import path from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { createBackup } from "../src/lib/backup";
import { changePassword, passwordProblem } from "../src/lib/auth";
import { configureConnection } from "../src/lib/db";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "revenueos.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const BACKUP_DIR = process.env.REVENUEOS_BACKUP_DIR ?? path.join(DATA_DIR, "backups");

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

interface UserRow {
  id: number;
  username: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

/**
 * Read a line with the terminal echo off.
 *
 * Nothing is echoed — not even asterisks, which tell a shoulder-surfer the
 * length. readline writes the prompt through the same hook, so muting has to
 * start AFTER `question()` has emitted it.
 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let muted = false;
    let answered = false;
    // readline's own hook; typed loosely because it is not in the public d.ts.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
    // Ctrl-C, Ctrl-D or a closed stdin fire 'close' with no answer. Without
    // this the promise simply never settles, node runs out of work, and the
    // process exits 0 having changed nothing — a cancelled reset that reads
    // exactly like a successful one. Fail loudly instead.
    rl.on("close", () => {
      if (!answered) reject(new Error("Cancelled — nothing was changed."));
    });
    rl.question(prompt, (answer) => {
      answered = true;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

function openDb(): Database.Database {
  const db = new Database(DB_PATH, { fileMustExist: true });
  configureConnection(db);
  return db;
}

function listUsers(db: Database.Database): UserRow[] {
  return db
    .prepare(
      `SELECT id, username, role, created_at, last_login_at, failed_attempts, locked_until
         FROM auth_users ORDER BY id`
    )
    .all() as UserRow[];
}

function printUsers(users: UserRow[], now: string): void {
  if (!users.length) {
    console.log("No accounts exist yet. Start the app and create the first one.");
    return;
  }
  console.log(`${users.length} account(s):\n`);
  for (const u of users) {
    const locked = u.locked_until && u.locked_until > now ? `  LOCKED until ${u.locked_until}` : "";
    const seen = u.last_login_at ? `last login ${u.last_login_at}` : "never signed in";
    console.log(`  ${u.username}  (${u.role})  ${seen}${locked}`);
  }
  console.log("\nReset one with:  npm run reset-password -- --user <username>");
}

function findUser(users: UserRow[], wanted: string): UserRow {
  const exact = users.find((u) => u.username === wanted);
  if (exact) return exact;
  // Usernames are stored as typed. A near-miss is far more likely to be a
  // capitalisation slip than a genuinely absent account, so say so rather
  // than reporting "no such user" to someone looking straight at their name.
  const near = users.find((u) => u.username.toLowerCase() === wanted.trim().toLowerCase());
  if (near) throw new Error(`No user "${wanted}". Did you mean "${near.username}"? Usernames are case-sensitive.`);
  throw new Error(`No user "${wanted}". Run with --list to see the accounts.`);
}

async function main(): Promise<void> {
  if (has("--help") || (args.length === 0 && process.stdin.isTTY)) {
    console.log(
      "Reset a RevenueOS password.\n\n" +
        "  npm run reset-password -- --list\n" +
        "  npm run reset-password -- --user <username>\n\n" +
        "The new password is typed at a prompt, never passed on the command line."
    );
    return;
  }

  const now = new Date().toISOString();
  const db = openDb();
  try {
    const users = listUsers(db);

    if (has("--list")) {
      printUsers(users, now);
      return;
    }

    const wanted = valueOf("--user") ?? args.find((a) => !a.startsWith("--"));
    if (!wanted) throw new Error("Which account? Pass --user <username>, or --list to see them.");
    const user = findUser(users, wanted);

    if (!process.stdin.isTTY) {
      throw new Error(
        "This needs a terminal — the new password is typed, never piped or passed as an argument."
      );
    }

    console.log(`Resetting the password for ${user.username} (${user.role}).`);
    if (user.locked_until && user.locked_until > now) {
      console.log(`That account is locked until ${user.locked_until}. This reset clears the lock.`);
    }
    console.log("");

    const password = await readSecret("New password: ");
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const again = await readSecret("Type it again:  ");
    if (password !== again) throw new Error("The two entries do not match. Nothing was changed.");

    console.log("\nTaking a verified backup first…");
    const backup = await createBackup(db, BACKUP_DIR, now, UPLOADS_DIR);
    console.log(`✓ Backup verified: ${backup.dir}`);

    // Counted before the change, because changePassword destroys them.
    const { n: sessions } = db
      .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = @id`)
      .get({ id: user.id }) as { n: number };

    // audit_log.company_id is NOT NULL, and an access change is not scoped to
    // one book — so it is recorded in every book the account could open. The
    // password itself, old or new, appears in no snapshot.
    const companies = db.prepare(`SELECT id FROM companies`).all() as { id: number }[];
    const writeAuditRow = db.prepare(
      `INSERT INTO audit_log
         (company_id, actor_user_id, action, entity, entity_id, summary,
          before_json, after_json, created_at)
       VALUES (@company_id, NULL, 'auth.password_reset', 'auth_users', @entity_id, @summary,
               NULL, @after, @now)`
    );

    db.transaction(() => {
      changePassword(db, user.id, password);
      for (const c of companies) {
        writeAuditRow.run({
          company_id: c.id,
          entity_id: user.id,
          summary: `Password for ${user.username} was reset from the console on this machine.`,
          after: JSON.stringify({
            username: user.username,
            sessions_revoked: sessions,
            lock_cleared: Boolean(user.locked_until && user.locked_until > now),
          }),
          now,
        });
      }
    })();

    console.log(`✓ Password changed for ${user.username}.`);
    console.log(`  ${sessions} session(s) revoked — any signed-in browser must log in again.`);
    console.log(`  Recorded in the audit log of ${companies.length} book(s), actor: console.`);
    console.log("\nSign in at http://localhost:3322 to confirm it works before you close this.");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ Password reset FAILED: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
