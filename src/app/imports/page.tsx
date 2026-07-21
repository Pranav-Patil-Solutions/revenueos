import Link from "next/link";
import { getDb } from "@/lib/db";
import { ImportExcel } from "@/components/import-excel";
import { ImportTally } from "@/components/import-tally";
import type { PartyRow } from "@/lib/types";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  await requireSession();

  const db = getDb();
  const parties = db
    .prepare("SELECT * FROM parties ORDER BY name")
    .all() as PartyRow[];
  const accounts = db
    .prepare("SELECT id, code, name FROM accounts ORDER BY code")
    .all() as { id: number; code: string; name: string }[];

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Imports</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Bring existing books in bulk. Every import lands in the same review
        screen — nothing posts without your eyes on it.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-hairline bg-surface p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold tracking-tight">
              Excel / Sheets (CSV)
            </h2>
            <a
              href="/api/import/template"
              className="text-[12.5px] font-medium text-accent hover:opacity-80"
              download
            >
              Download template
            </a>
          </div>
          <p className="mt-1 mb-4 text-[12.5px] text-ink-3">
            Fill the template — one row per entry, amounts in rupees, party by
            exact name. Rows with problems come in unticked with the reason
            noted.
          </p>
          {parties.length === 0 ? (
            <p className="rounded-lg border border-hairline bg-surface-2/40 px-4 py-6 text-center text-[12.5px] text-ink-3">
              Add a{" "}
              <Link href="/parties" className="font-medium text-accent">
                party
              </Link>{" "}
              first — imports need a default party.
            </p>
          ) : (
            <ImportExcel parties={parties} />
          )}
        </section>

        <section className="rounded-xl border border-hairline bg-surface p-5">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Tally (Day Book XML)
          </h2>
          <p className="mt-1 mb-4 text-[12.5px] text-ink-3">
            Export the Day Book as XML. Each ledger is matched to a party or
            account once and remembered — later imports go straight to review.
            Journals and anything ambiguous come in unticked with the reason.
          </p>
          {parties.length === 0 ? (
            <p className="rounded-lg border border-hairline bg-surface-2/40 px-4 py-6 text-center text-[12.5px] text-ink-3">
              Add a{" "}
              <Link href="/parties" className="font-medium text-accent">
                party
              </Link>{" "}
              first — imports need a default party.
            </p>
          ) : (
            <ImportTally parties={parties} accounts={accounts} />
          )}
        </section>
      </div>
    </div>
  );
}
