import Link from "next/link";
import { recentAudit } from "@/lib/audit";
import { requireBook } from "@/lib/dal";
import { formatTimestamp } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Dotted action → a short human label. Unknown actions fall back to the raw
 * string rather than being hidden: a log that silently drops rows it does not
 * recognise is worse than one that shows an ugly name. */
const ACTION_LABEL: Record<string, string> = {
  "document.post": "Posted a document",
  "journal.post": "Posted a voucher",
  "books.lock": "Locked the books",
  "company.settings": "Changed company settings",
  "bank_account.create": "Added an account",
  "bank_account.rename": "Renamed an account",
  "bank_account.set_default": "Changed the default account",
  "bank_account.archive": "Archived an account",
  "staff.create": "Added a staff member",
  "staff.role_change": "Changed a role",
};

export default async function AuditPage() {
  const { book } = await requireBook("book.read");
  const entries = recentAudit(book, 200);

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Audit trail</h1>
        <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
          ← Settings
        </Link>
      </div>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Every action on this book that someone may later have to account for.
        Append-only — the app cannot edit or delete a line here, and neither can
        anyone using it.
      </p>

      {entries.length === 0 ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface p-8 text-center">
          <p className="text-[13.5px] text-ink-2">Nothing recorded for this book yet.</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Entries appear here as soon as anything is posted or changed.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="w-40 px-3 py-2.5 font-medium">When</th>
                <th className="w-28 px-3 py-2.5 font-medium">Who</th>
                <th className="w-44 px-3 py-2.5 font-medium">Action</th>
                <th className="px-3 py-2.5 font-medium">What</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-hairline/60 last:border-0 align-top hover:bg-surface-2/50"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-ink-3">
                    {formatTimestamp(e.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    {/* A NULL actor is a real state — a migration or a CLI
                        script. It renders as "unknown", never as a guessed
                        name. */}
                    {e.actor_username ?? (
                      <span className="text-ink-3 italic">unknown</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {ACTION_LABEL[e.action] ?? e.action}
                  </td>
                  <td className="px-3 py-2">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
