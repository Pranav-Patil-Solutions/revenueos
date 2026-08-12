import Link from "next/link";
import { createStaffAction, setStaffRoleAction } from "@/lib/actions";
import { requireBook, userCan } from "@/lib/dal";
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/roles";
import { listStaff, ownerCount } from "@/lib/staff";
import { formatTimestamp } from "@/lib/format";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  /**
   * Read-level guard here, then an explicit capability check — deliberately NOT
   * `requireBook("users.manage")`.
   *
   * `requireBook` THROWS on a capability failure, which is right for a Server
   * Action (silently redirecting a POST would look to the caller like it had
   * succeeded) but wrong for a page: a clerk who follows a stale link or types
   * the URL would get a 500 "Application error", which reads as a broken app
   * rather than as a refusal. Next's `forbidden()` would be the idiomatic
   * answer but is still behind the experimental `authInterrupts` flag, and
   * turning that on for one settings page is not a trade this app should make.
   *
   * So the page explains itself instead. Nothing sensitive is loaded unless the
   * check passes, and the ACTIONS still enforce `users.manage` independently —
   * this branch is presentation, never the security boundary.
   */
  const { book, user } = await requireBook();
  const allowed = userCan(user, "users.manage");

  if (!allowed) {
    return (
      <div>
        <div className="flex items-baseline gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">Staff &amp; roles</h1>
          <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
            ← Settings
          </Link>
        </div>
        <div className="mt-6 max-w-2xl rounded-xl border border-hairline bg-surface p-8">
          <p className="text-[14px] font-semibold">This page is for owners.</p>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Your role ({ROLE_LABEL[user.role]}) cannot see or change who has
            access to the books. Ask an owner if you need an account changed.
          </p>
        </div>
      </div>
    );
  }

  const staff = listStaff(book.db);
  const owners = ownerCount(book.db);

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Staff &amp; roles</h1>
        <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
          ← Settings
        </Link>
      </div>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Everyone who can open the books on this machine. A role is about
        consequence, not convenience: staging an entry is reversible, posting one
        is not.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2.5 font-medium">User</th>
                <th className="w-40 px-3 py-2.5 font-medium">Role</th>
                <th className="w-36 px-3 py-2.5 font-medium">Last signed in</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                const isSelf = s.id === user.user_id;
                const isLastOwner = s.role === "owner" && owners <= 1;
                // Two different reasons the select is disabled, and the row says
                // which — a control that is simply dead teaches nobody anything.
                const frozenBecause = isSelf
                  ? "You cannot change your own role — ask the other owner."
                  : isLastOwner
                    ? "The only owner. Promote someone else first."
                    : null;
                return (
                  <tr
                    key={s.id}
                    className="border-b border-hairline/60 last:border-0 hover:bg-surface-2/50"
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{s.username}</span>
                      {isSelf && (
                        <span className="ml-2 rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
                          you
                        </span>
                      )}
                      {s.locked_until && (
                        <span className="ml-2 text-[11px] text-danger">
                          locked until {formatTimestamp(s.locked_until)}
                        </span>
                      )}
                      {frozenBecause && (
                        <p className="mt-0.5 text-[11px] text-ink-3">{frozenBecause}</p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {frozenBecause ? (
                        <span className="text-ink-2">{ROLE_LABEL[s.role]}</span>
                      ) : (
                        <form action={setStaffRoleAction} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={s.id} />
                          <select
                            name="role"
                            defaultValue={s.role}
                            aria-label={`Role for ${s.username}`}
                            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12.5px]"
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-accent"
                          >
                            Save
                          </button>
                        </form>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-3">
                      {s.last_login_at ? formatTimestamp(s.last_login_at) : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="border-t border-hairline px-3 py-3">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              What the roles mean
            </p>
            <dl className="mt-2 grid gap-1.5">
              {ROLES.map((r) => (
                <div key={r} className="flex gap-2 text-[12.5px]">
                  <dt className="w-24 shrink-0 font-medium">{ROLE_LABEL[r]}</dt>
                  <dd className="text-ink-2">{ROLE_DESCRIPTION[r]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <form action={createStaffAction} className="card h-fit p-5">
          <p className="text-[13.5px] font-semibold">Add someone</p>
          <div className="mt-4 flex flex-col gap-3.5">
            <div>
              <label className={label} htmlFor="username">Username</label>
              <input id="username" name="username" className={field} required />
            </div>
            <div>
              <label className={label} htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                className={field}
                required
              />
              <p className="mt-1 text-[11px] text-ink-3">
                At least 10 characters, with a letter and a number. There is no
                reset e-mail on this machine — write it down.
              </p>
            </div>
            <div>
              <label className={label} htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="clerk" className={field}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn mt-4 w-full">
            Add staff member
          </button>
        </form>
      </div>
    </div>
  );
}
