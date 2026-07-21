import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { ExportLinks } from "@/components/report-tabs";
import { formatDate, inr } from "@/lib/format";
import { partyStatement } from "@/lib/reports";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function PartyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();

  const { id } = await params;
  const statement = partyStatement(getDb(), Number(id));
  if (!statement) notFound();
  const { party, lines, closing_paise, cross_ledger_paise, net_position_paise } =
    statement;
  const owesUs = party.kind === "customer";

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{party.name}</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {party.kind === "customer" ? "Customer" : "Supplier"}
            {party.gstin ? ` · GSTIN ${party.gstin}` : ""}
            {party.state_code ? ` · state ${party.state_code}` : ""}
            {party.phone ? ` · ${party.phone}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ExportLinks base={`/api/export/statement?party=${party.id}`} />
          <Link href="/parties" className="text-[12.5px] font-medium text-accent hover:opacity-80">
            All parties
          </Link>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl border border-hairline bg-surface p-5">
          <p className="text-[12.5px] font-medium text-ink-3">
            {owesUs ? "They owe you (receivables)" : "You owe them (payables)"}
          </p>
          <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight" style={{ fontVariantNumeric: "tabular-nums" }}>
            {inr(closing_paise)}
          </p>
        </div>
        {cross_ledger_paise !== 0 && (
          <>
            <div className="rounded-xl border border-hairline bg-surface p-5">
              <p className="text-[12.5px] font-medium text-ink-3">
                {owesUs
                  ? "You owe them (payables ledger)"
                  : "They owe you (receivables ledger)"}
              </p>
              <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight" style={{ fontVariantNumeric: "tabular-nums" }}>
                {inr(cross_ledger_paise)}
              </p>
              <p className="mt-2.5 text-[12px] text-ink-3">
                From cross-trades and refunds posted on the other side.
              </p>
            </div>
            <div className="rounded-xl border border-hairline bg-surface p-5">
              <p className="text-[12.5px] font-medium text-ink-3">Net position</p>
              <p
                className={`mt-2 text-[26px] font-semibold leading-none tracking-tight ${
                  net_position_paise < 0 ? "text-warning" : ""
                }`}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {inr(net_position_paise)}
              </p>
              <p className="mt-2.5 text-[12px] text-ink-3">
                {owesUs ? "Receivable minus payable." : "Payable minus receivable."}
              </p>
            </div>
          </>
        )}
      </div>

      <div className="mt-6">
        <p className="mb-3 text-[13.5px] font-semibold">Statement</p>
        {lines.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
            <p className="text-[13.5px] font-medium text-ink-2">No posted entries yet</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Capture and post a ledger page for {party.name} and the running
              statement builds itself.
            </p>
            <Link
              href="/capture"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Capture a page
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Particulars</th>
                  <th className="px-5 py-3 font-medium">Ref</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 text-right font-medium">Debit</th>
                  <th className="px-5 py-3 text-right font-medium">Credit</th>
                  <th className="px-5 py-3 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                {lines.map((l) => (
                  <tr key={l.journal_id} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-3 whitespace-nowrap text-ink-2">{formatDate(l.entry_date)}</td>
                    <td className="max-w-72 truncate px-5 py-3">{l.memo || "—"}</td>
                    <td className="px-5 py-3 text-ink-3">{l.ref_no || "—"}</td>
                    <td className="px-5 py-3 capitalize text-ink-3">{l.entry_type.replace("_", " ")}</td>
                    <td className="px-5 py-3 text-right">
                      {l.debit_paise > 0 ? inr(l.debit_paise) : ""}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {l.credit_paise > 0 ? inr(l.credit_paise) : ""}
                    </td>
                    <td className="px-5 py-3 text-right font-medium">{inr(l.balance_paise)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-hairline bg-surface-2/50 font-semibold">
                  <td className="px-5 py-3.5" colSpan={6}>
                    Closing balance
                  </td>
                  <td className="px-5 py-3.5 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {inr(closing_paise)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
