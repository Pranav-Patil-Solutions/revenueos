import { ExportLinks } from "@/components/report-tabs";
import { FySelect } from "@/components/fy-select";
import { TaxTabs } from "@/components/tax-tabs";
import { addItAdjustment, addTaxPayment, deleteItAdjustment } from "@/lib/actions";
import { formatDate, inr, todayIso } from "@/lib/format";
import { currentFy, fyLabel, fyList } from "@/lib/fy";
import { buildComputation } from "@/lib/tax/computation";
import type { ItAdjustmentRow } from "@/lib/types";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

const ENTITY_LABEL: Record<string, string> = {
  proprietorship: "Proprietorship (individual)",
  partnership: "Partnership firm / LLP",
  company: "Domestic company",
};

const PAYMENT_LABEL: Record<string, string> = {
  advance: "Advance tax",
  tds: "TDS credit",
  self_assessment: "Self-assessment",
};

export default async function ComputationPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const { book } = await requireBook();

  const sp = await searchParams;
  const books = fyList(book);
  const fys = books.includes(currentFy()) ? books : [currentFy(), ...books];
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : fys[0];

  const c = buildComputation(book, fy);
  const adjustments = book.all(
    "SELECT * FROM it_adjustments WHERE company_id = @company_id AND fy = @fy ORDER BY id",
    { fy }
  ) as ItAdjustmentRow[];
  const presumptive = c.presumptive !== "";

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Tax &amp; filing</h1>
      <TaxTabs />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex items-center gap-2">
          <FySelect fys={fys} value={fy} />
          <button
            type="submit"
            className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            Apply
          </button>
        </form>
        <ExportLinks base={`/api/export/computation?fy=${fy}`} />
      </div>

      {/* The rates used are not confirmed for this year — say so, at the top,
          before any number is read. */}
      {c.caveat && (
        <p className="mt-4 rounded-lg border border-critical/40 bg-critical/10 px-4 py-2.5 text-[12.5px] text-critical">
          <strong className="font-semibold">Rates not confirmed.</strong>{" "}
          {c.caveat} This computation is provisional — check the figures against
          the Act for the year being filed before anything is submitted.
        </p>
      )}

      <section className="mt-5 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Computation of total income · {fyLabel(fy)}
          </h2>
          <p className="text-[12px] text-ink-3">
            {ENTITY_LABEL[c.entity_type] ?? c.entity_type} ·{" "}
            {c.entity_type === "company"
              ? c.regime === "new"
                ? "concessional rate elected"
                : "normal rate"
              : `${c.regime} regime`}
            {presumptive && ` · presumptive ${c.presumptive}`} · rates{" "}
            {c.rates_tax_year}
          </p>
        </div>

        <div>
          {c.lines.map((l, i) => (
            <div
              key={i}
              className="flex items-start justify-between gap-4 border-b border-hairline/60 px-5 py-2.5 text-[13px]"
            >
              <span className="text-ink-2">
                {l.label}
                {l.note && (
                  <span className="ml-2 text-[11.5px] text-ink-3">{l.note}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums">
                {l.subtract ? "(" : ""}
                {inr(l.amount_paise)}
                {l.subtract ? ")" : ""}
              </span>
            </div>
          ))}

          <Row label="Gross total income" amount={c.gross_total_income_paise} />
          <Row
            label="Total income (rounded)"
            amount={c.taxable_income_paise}
            strong
          />
        </div>

        <div className="border-t border-hairline">
          <Row label={`Tax — ${c.tax.basis}`} amount={c.tax.tax_before_rebate_paise} />
          {c.tax.rebate_paise > 0 && (
            <Row label="Less: rebate" amount={c.tax.rebate_paise} subtract />
          )}
          {c.tax.surcharge_paise > 0 && (
            <Row label="Add: surcharge" amount={c.tax.surcharge_paise} />
          )}
          {c.tax.surcharge_marginal_relief_paise > 0 && (
            <Row
              label="Less: marginal relief on surcharge"
              amount={c.tax.surcharge_marginal_relief_paise}
              subtract
            />
          )}
          <Row label="Add: cess" amount={c.tax.cess_paise} />
          <Row label="Total tax" amount={c.tax.total_tax_paise} strong />
          {c.payments_paise > 0 && (
            <Row label="Less: taxes already paid" amount={c.payments_paise} subtract />
          )}
          <div className="flex items-center justify-between bg-surface-2/50 px-5 py-3 text-[14px] font-semibold">
            <span>
              {c.net_payable_paise < 0 ? "Refund due" : "Balance payable"}
            </span>
            <span className="tabular-nums">
              {inr(Math.abs(c.net_payable_paise))}
            </span>
          </div>
        </div>

        <p className="border-t border-hairline px-5 py-3 text-[11.5px] text-ink-3">
          Prepared from the books plus the adjustments below. CA to verify — this
          is filing preparation, not filing advice.
        </p>
      </section>

      {c.partner_remuneration_ceiling_paise !== null && (
        <p className="mt-4 rounded-lg border border-hairline bg-surface-2/60 px-4 py-2.5 text-[12.5px] text-ink-3">
          <strong className="font-medium text-ink-2">
            Partner remuneration ceiling: {inr(c.partner_remuneration_ceiling_paise)}
          </strong>{" "}
          measured on net profit per the P&amp;L ({inr(c.book_profit_paise)}).
          Indicative only — if remuneration is already debited in the P&amp;L,
          add it back before applying this. Remuneration above the ceiling is
          not deductible; enter the excess as an addback. Never applied
          automatically. CA to verify.
        </p>
      )}

      {/* ---------------- Adjustments ---------------- */}
      <section className="mt-6 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Adjustments</h2>
          <p className="mt-0.5 text-[12px] text-ink-3">
            Addbacks raise total income, deductions lower it. Never posted to the
            books, so these can be changed or removed at any time.
            {presumptive && " Ignored while a presumptive scheme is in force."}
          </p>
        </div>
        {adjustments.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-3">
            No adjustments for {fyLabel(fy)}.
          </p>
        ) : (
          adjustments.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-4 border-b border-hairline/60 px-5 py-2.5 text-[13px]"
            >
              <span className="text-ink-2">
                <span
                  className={`mr-2 rounded-full border px-2 py-0.5 text-[10.5px] ${
                    a.kind === "addback"
                      ? "border-hairline text-ink-3"
                      : "border-hairline text-ink-3"
                  }`}
                >
                  {a.kind === "addback" ? "add" : "less"}
                </span>
                {a.description}
                {a.section && (
                  <span className="ml-2 text-[11.5px] text-ink-3">{a.section}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums">{inr(a.amount_paise)}</span>
                <form action={deleteItAdjustment}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="fy" value={fy} />
                  <button
                    type="submit"
                    className="text-[12px] font-medium text-ink-3 hover:text-critical"
                  >
                    Remove
                  </button>
                </form>
              </span>
            </div>
          ))
        )}
        <form
          action={addItAdjustment}
          className="grid gap-3 border-t border-hairline px-5 py-4 sm:grid-cols-2 lg:grid-cols-5"
        >
          <input type="hidden" name="fy" value={fy} />
          <div className="lg:col-span-2">
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="adj-desc">
              Description
            </label>
            <input id="adj-desc" name="description" required className={field} placeholder="Donation disallowed" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="adj-kind">
              Kind
            </label>
            <select id="adj-kind" name="kind" className={field} defaultValue="addback">
              <option value="addback">Addback</option>
              <option value="deduction">Deduction</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="adj-section">
              Note (optional)
            </label>
            <input id="adj-section" name="section" className={field} placeholder="your own reference" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="adj-amount">
              Amount ₹
            </label>
            <input id="adj-amount" name="amount" required inputMode="decimal" className={field} placeholder="25,000" />
          </div>
          <div className="lg:col-span-5">
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Add adjustment
            </button>
          </div>
        </form>
      </section>

      {/* ---------------- Payments + advance tax ---------------- */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-hairline bg-surface">
          <h2 className="border-b border-hairline px-5 py-3.5 text-[15px] font-semibold tracking-tight">
            Taxes paid
          </h2>
          {c.payments.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-ink-3">
              Nothing recorded for {fyLabel(fy)}.
            </p>
          ) : (
            c.payments.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between border-b border-hairline/60 px-5 py-2.5 text-[13px]"
              >
                <span className="text-ink-2">
                  {PAYMENT_LABEL[p.kind] ?? p.kind}
                  <span className="ml-2 text-[11.5px] text-ink-3">
                    {formatDate(p.paid_on)}
                    {p.note && ` · ${p.note}`}
                  </span>
                </span>
                <span className="tabular-nums">{inr(p.amount_paise)}</span>
              </div>
            ))
          )}
          <form action={addTaxPayment} className="grid gap-3 border-t border-hairline px-5 py-4 sm:grid-cols-2">
            <input type="hidden" name="fy" value={fy} />
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="pay-kind">
                Kind
              </label>
              <select id="pay-kind" name="kind" className={field} defaultValue="advance">
                <option value="advance">Advance tax</option>
                <option value="tds">TDS credit</option>
                <option value="self_assessment">Self-assessment</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="pay-date">
                Paid on
              </label>
              <input id="pay-date" name="paid_on" type="date" required defaultValue={todayIso()} className={field} />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="pay-amount">
                Amount ₹
              </label>
              <input id="pay-amount" name="amount" required inputMode="decimal" className={field} placeholder="10,000" />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="pay-note">
                Note (optional)
              </label>
              <input id="pay-note" name="note" className={field} placeholder="challan no." />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Record payment
              </button>
            </div>
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-hairline bg-surface">
          <div className="border-b border-hairline px-5 py-3.5">
            <h2 className="text-[15px] font-semibold tracking-tight">
              Advance tax schedule
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-3">
              Cumulative instalments on the total tax above, for {fyLabel(fy)}.
            </p>
          </div>
          {c.advance_tax.map((a) => (
            <div
              key={a.due}
              className="flex items-center justify-between border-b border-hairline/60 px-5 py-2.5 text-[13px]"
            >
              <span className="text-ink-2">
                {a.due}
                <span className="ml-2 text-[11.5px] text-ink-3">
                  {a.cumulative_percent}% cumulative
                </span>
              </span>
              <span className="flex items-center gap-4">
                <span className="tabular-nums text-ink-3">
                  {inr(a.cumulative_paise)}
                </span>
                <span className="w-24 text-right tabular-nums font-medium">
                  {inr(a.instalment_paise)}
                </span>
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function Row({
  label,
  amount,
  subtract,
  strong,
}: {
  label: string;
  amount: number;
  subtract?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between border-b border-hairline/60 px-5 py-2.5 text-[13px] ${
        strong ? "font-semibold" : ""
      }`}
    >
      <span className={strong ? "" : "text-ink-2"}>{label}</span>
      <span className="tabular-nums">
        {subtract ? "(" : ""}
        {inr(amount)}
        {subtract ? ")" : ""}
      </span>
    </div>
  );
}
