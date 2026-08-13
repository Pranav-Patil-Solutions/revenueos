import { VoucherForm } from "@/components/voucher-form";
import { listBankAccounts } from "@/lib/bank-accounts";
import { listCostCentres } from "@/lib/cost-centres";
import { getCompany } from "@/lib/companies";
import { formatDate, inr, todayIso } from "@/lib/format";
import { KEY_HINTS, type VoucherNavKind } from "@/lib/keymap";
import type { CompanyRow, JournalKind } from "@/lib/types";
import { requireBook, userCan } from "@/lib/dal";

export const dynamic = "force-dynamic";

const KINDS: VoucherNavKind[] = [
  "contra",
  "payment",
  "receipt",
  "journal",
  "sale",
  "purchase",
  "credit_note",
  "debit_note",
];

const KIND_LABELS: Partial<Record<JournalKind, string>> = {
  contra: "Contra",
  payment: "Payment",
  receipt: "Receipt",
  journal: "Journal",
  sale: "Sale",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
};

interface RecentVoucher {
  id: number;
  entry_date: string;
  entry_type: JournalKind;
  memo: string;
  ref_no: string;
  total_paise: number;
}

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; posted?: string }>;
}) {
  const { book, user } = await requireBook();

  const sp = await searchParams;
  const kind: VoucherNavKind = KINDS.includes(sp.kind as VoucherNavKind)
    ? (sp.kind as VoucherNavKind)
    : "sale";
  const postedId = /^\d+$/.test(sp.posted ?? "") ? Number(sp.posted) : null;

  const settings = getCompany(book.db, book.companyId) as CompanyRow;
  const parties = book.all(
    "SELECT id, name, kind FROM parties WHERE company_id = @company_id ORDER BY name"
  ) as { id: number; name: string; kind: "customer" | "supplier" }[];
  const accounts = book.all(
    "SELECT code, name FROM accounts WHERE company_id = @company_id ORDER BY code"
  ) as { code: string; name: string }[];
  const bankAccounts = listBankAccounts(book).map((ba) => ({
    id: ba.id,
    name: ba.name,
    kind: ba.kind,
    account_code: ba.account_code,
  }));
  // Active only — an archived centre must not be offered for a fresh entry
  // (postManualVoucher refuses one anyway; this is so the list never lies).
  const costCentres = listCostCentres(book).map((cc) => ({
    id: cc.id,
    code: cc.code,
    name: cc.name,
  }));
  const recent = book.all(
    `SELECT j.id, j.entry_date, j.entry_type, j.memo, j.ref_no,
            (SELECT SUM(debit_paise) FROM journal_lines
              WHERE journal_id = j.id AND company_id = @company_id) AS total_paise
     FROM journals j
     WHERE j.company_id = @company_id AND j.source_document_id IS NULL
     ORDER BY j.id DESC LIMIT 8`
  ) as RecentVoucher[];

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Vouchers</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Manual entry with Tally keys — each voucher posts one immutable
            journal.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_260px]">
        <VoucherForm
          key={kind}
          kind={kind}
          parties={parties}
          accounts={accounts}
          canPost={userCan(user, "entry.post")}
          bankAccounts={bankAccounts}
          costCentres={costCentres}
          today={todayIso()}
          defaultGstRate={settings.default_gst_rate}
          postedId={postedId}
        />

        <div className="flex h-fit flex-col gap-6">
          {/* Tally key rail */}
          <div className="rounded-xl border border-hairline bg-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
              Keys
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {KEY_HINTS.filter((h) => h.keys !== "⌃B").map((h) => (
                <div
                  key={h.keys}
                  className="flex items-center justify-between text-[12.5px]"
                >
                  <span className="text-ink-2">{h.label}</span>
                  <kbd className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-ink-2">
                    {h.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-hairline bg-surface">
            <p className="border-b border-hairline px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
              Recent vouchers
            </p>
            {recent.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">
                Nothing posted manually yet.
              </p>
            ) : (
              recent.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between gap-3 border-b border-hairline/60 px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-medium">
                      {KIND_LABELS[v.entry_type] ?? v.entry_type}
                      {v.memo ? ` — ${v.memo}` : ""}
                    </p>
                    <p className="text-[11.5px] text-ink-3">
                      {formatDate(v.entry_date)} · #{v.id}
                    </p>
                  </div>
                  <span className="shrink-0 text-[12.5px] font-medium tabular-nums">
                    {inr(v.total_paise)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
