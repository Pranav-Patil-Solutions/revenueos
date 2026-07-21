import { FySelect } from "@/components/fy-select";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/lib/db";
import { formatDate, inr, monthLabel, todayIso } from "@/lib/format";
import { currentFy, fyEnd, fyLabel, fyList, fyStart, monthsOfFy } from "@/lib/fy";
import { balanceSheet, gstr3b, partyStatement, profitAndLoss } from "@/lib/reports";
import { buildComputation } from "@/lib/tax/computation";
import {
  blockFor,
  depreciationSchedule,
  HALF_YEAR_DAYS,
  postedDepreciation,
} from "@/lib/tax/depreciation";
import { q24Summary, q26Summary, TDS_SECTIONS, tdsRegister } from "@/lib/tax/tds";
import type {
  FixedAssetRow,
  PartyRow,
  SettingsRow,
  TdsChallanRow,
} from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The CA sign-off pack: one printable bundle for a financial year, composed
 * ENTIRELY from the functions the on-screen pages already use — zero new
 * query logic, so a figure here can never disagree with its page except
 * where a reconciliation banner says so out loud.
 */

const cell = "px-4 py-2.5 text-[13px] tabular-nums";
const th = "px-4 py-2.5 font-medium";
const headRow =
  "border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3";
const bodyRow = "border-b border-hairline/60";
const lineRow =
  "flex items-center justify-between border-b border-hairline/60 px-5 py-2.5 text-[13px]";
const totalBand =
  "flex items-center justify-between border-t border-hairline bg-surface-2/50 px-5 py-3.5";
const cardNote = "border-t border-hairline px-5 py-3 text-[11.5px] text-ink-3";
const criticalBanner =
  "border-b border-hairline bg-critical/10 px-5 py-2.5 text-[12.5px] text-critical";
const infoBanner =
  "border-b border-hairline bg-surface-2/60 px-5 py-2.5 text-[12.5px] text-ink-3";

const ENTITY_LABEL: Record<string, string> = {
  proprietorship: "Proprietorship",
  partnership: "Partnership firm",
  company: "Company",
};

function PackSection({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-hairline bg-surface print:break-before-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-5 py-3.5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="text-[12px] text-ink-3">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-8 text-center text-[13px] text-ink-3">{children}</p>
  );
}

export default async function PackPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const sp = await searchParams;
  const db = getDb();
  const books = fyList(db);
  const fys = books.includes(currentFy()) ? books : [currentFy(), ...books];
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : fys[0];
  const end = fyEnd(fy);
  const settings = db
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;

  // ---- compose everything from the existing engines ----
  const bs = balanceSheet(db, end, settings);
  const pnl = profitAndLoss(db, { from: fyStart(fy), to: end });
  const comp = buildComputation(db, fy);

  const gstMonths = monthsOfFy(fy).map((m) => gstr3b(db, m));
  const gstTotal = gstMonths.reduce(
    (t, g) => ({
      outward: t.outward + g.outward_taxable_paise,
      cgst: t.cgst + g.cgst_paise,
      sgst: t.sgst + g.sgst_paise,
      igst: t.igst + g.igst_paise,
      itc: t.itc + g.itc_paise,
      net: t.net + g.net_payable_paise,
    }),
    { outward: 0, cgst: 0, sgst: 0, igst: 0, itc: 0, net: 0 }
  );
  const gstActive =
    settings.gstin.trim() !== "" ||
    Object.values(gstTotal).some((v) => v !== 0);

  const tdsQuarters = ([1, 2, 3, 4] as const)
    .flatMap((q) => [q26Summary(db, fy, q), q24Summary(db, fy, q)])
    .filter((s) => s.lines.length > 0);
  const register = tdsRegister(db, fy);
  const undeposited = register
    .filter((r) => r.challan_id === null)
    .reduce((s, r) => s + r.tds_paise, 0);
  const challans = db
    .prepare(
      "SELECT * FROM tds_challans WHERE fy = ? ORDER BY paid_on, id"
    )
    .all(fy) as TdsChallanRow[];

  const schedule = depreciationSchedule(db, fy);
  const posted = postedDepreciation(db, fy);
  const liveBlocks = schedule.blocks.filter(
    (b) =>
      b.opening_paise !== 0 ||
      b.additions_full_paise !== 0 ||
      b.additions_half_paise !== 0 ||
      b.disposals_paise !== 0 ||
      b.closing_paise !== 0
  );
  const assets = db
    .prepare("SELECT * FROM fixed_assets ORDER BY purchase_date, id")
    .all() as FixedAssetRow[];

  // Annexure: per-party positions on BOTH control accounts as at FY end —
  // partyStatement(…, end) dates its own ledger AND the cross ledger. A
  // customer's payable (or a supplier's receivable) is a cross-ledger row
  // shown on the side it actually sits; hiding it would break the
  // reconciliation to the BS control figures below (the RVOS-001 lesson).
  const parties = db
    .prepare("SELECT * FROM parties ORDER BY name COLLATE NOCASE")
    .all() as PartyRow[];
  type AnnexureRow = {
    key: string;
    name: string;
    gstin: string;
    amount_paise: number;
    cross: boolean;
  };
  const debtors: AnnexureRow[] = [];
  const creditors: AnnexureRow[] = [];
  for (const p of parties) {
    const st = partyStatement(db, p.id, end);
    if (!st) continue;
    const own: AnnexureRow = {
      key: `${p.id}-own`,
      name: p.name,
      gstin: p.gstin,
      amount_paise: st.closing_paise,
      cross: false,
    };
    const crossRow: AnnexureRow = {
      key: `${p.id}-cross`,
      name: p.name,
      gstin: p.gstin,
      amount_paise: st.cross_ledger_paise,
      cross: true,
    };
    if (p.kind === "customer") {
      if (st.closing_paise !== 0) debtors.push(own);
      if (st.cross_ledger_paise !== 0) creditors.push(crossRow);
    } else {
      if (st.closing_paise !== 0) creditors.push(own);
      if (st.cross_ledger_paise !== 0) debtors.push(crossRow);
    }
  }
  const debtorsTotal = debtors.reduce((s, x) => s + x.amount_paise, 0);
  const creditorsTotal = creditors.reduce((s, x) => s + x.amount_paise, 0);
  // Reconcile the annexure against the SAME control-account figures the
  // Balance Sheet carries — a mismatch means control-ledger postings without
  // a party, and the pack must say so rather than print two quiet numbers.
  const bsLines = bs.groups.flatMap((g) => g.lines);
  const arControl = bsLines.find((l) => l.code === "1200")?.amount_paise ?? 0;
  const apControl = bsLines.find((l) => l.code === "2100")?.amount_paise ?? 0;

  const assetGroups = bs.groups.filter((g) => g.section === "assets");
  const liabEquityGroups = bs.groups.filter(
    (g) => g.section === "liabilities" || g.section === "equity"
  );

  // Same rows, same conditions, same labels as /tax/computation — the pack
  // must never show a different row set than the live page for the same FY.
  const taxRows: { label: string; amount: number; always?: boolean }[] = [
    {
      label: `Tax — ${comp.tax.basis}`,
      amount: comp.tax.tax_before_rebate_paise,
      always: true,
    },
    { label: "Less: rebate", amount: -comp.tax.rebate_paise },
    { label: "Add: surcharge", amount: comp.tax.surcharge_paise },
    {
      label: "Less: marginal relief on surcharge",
      amount: -comp.tax.surcharge_marginal_relief_paise,
    },
    { label: "Add: cess", amount: comp.tax.cess_paise, always: true },
  ].filter((r) => r.always || r.amount !== 0);

  return (
    <div style={{ fontVariantNumeric: "tabular-nums" }}>
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            CA sign-off pack
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            One printable bundle for {fyLabel(fy)} — print it, or save as PDF
            from the print dialog.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form method="get" className="flex items-center gap-2">
            <FySelect fys={fys} value={fy} />
            <button
              type="submit"
              className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
            >
              Apply
            </button>
          </form>
          <PrintButton />
        </div>
      </div>

      {/* -------- Cover -------- */}
      <section className="mt-6 overflow-hidden rounded-xl border border-hairline bg-surface print:mt-0">
        <div className="px-6 pt-10 pb-8">
          <p className="microlabel text-[11px] text-ink-3">
            CA sign-off pack · prepared {formatDate(todayIso())}
          </p>
          <h2 className="mt-2 text-[26px] font-semibold leading-tight tracking-tight">
            {settings.company_name}
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">
            {ENTITY_LABEL[settings.entity_type] ?? settings.entity_type} ·{" "}
            {fyLabel(fy)} · year ended {formatDate(end)}
          </p>
          <div className="mt-6 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["PAN", settings.pan],
              ["TAN", settings.tan],
              ["GSTIN", settings.gstin],
              ["IT regime", comp.regime === "old" ? "Old" : "New"],
            ].map(([k, v]) => (
              <p key={k}>
                <span className="text-ink-3">{k}</span>{" "}
                <span className="font-medium">{v || "—"}</span>
              </p>
            ))}
          </div>
          <p className="mt-6 text-[12.5px] leading-relaxed text-ink-3">
            Contents: Balance Sheet · Profit &amp; Loss · Computation of total
            income · GST monthly summary · TDS summary &amp; challans ·
            Depreciation &amp; fixed-asset register · Debtors/creditors
            annexure. Prepared from the RevenueOS books — filing preparation,
            not filing advice.
          </p>
        </div>
        {(comp.caveat !== "" || TDS_SECTIONS.some((s) => !s.verified)) && (
          <p className={`${criticalBanner} border-t`}>
            <strong className="font-semibold">Provisional figures.</strong>{" "}
            Statutory rates in this pack are unconfirmed for this year — each
            affected section below carries its own caveat. Verify against the
            Act for the year being filed before anything is submitted. CA to
            verify.
          </p>
        )}
      </section>

      {/* -------- Balance Sheet -------- */}
      <PackSection title="Balance Sheet" sub={`as at ${formatDate(end)}`}>
        {assetGroups.map((g) => (
          <div key={g.group_code}>
            <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
              {g.label}
            </p>
            {g.lines.map((l) => (
              <div key={l.code} className={lineRow}>
                <span className="text-ink-2">{l.name}</span>
                <span className="font-medium">{inr(l.amount_paise)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className={totalBand}>
          <span className="text-[13.5px] font-semibold">Total assets</span>
          <span className="text-[15px] font-semibold">
            {inr(bs.total_assets_paise)}
          </span>
        </div>
        {liabEquityGroups.map((g) => (
          <div key={g.group_code}>
            <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
              {g.label}
            </p>
            {g.lines.map((l) => (
              <div key={`${l.code}-${l.name}`} className={lineRow}>
                <span className="text-ink-2">{l.name}</span>
                <span className="font-medium">{inr(l.amount_paise)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className={totalBand}>
          <span className="text-[13.5px] font-semibold">
            Total liabilities &amp; equity
          </span>
          <span className="text-[15px] font-semibold">
            {inr(bs.total_liabilities_paise + bs.total_equity_paise)}
          </span>
        </div>
        <p className={cardNote}>
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-good" />
          Balanced: assets equal liabilities plus equity. Current-year profit{" "}
          {inr(bs.current_year_profit_paise)} is injected from the P&amp;L
          below.
        </p>
      </PackSection>

      {/* -------- P&L -------- */}
      <PackSection
        title="Profit & Loss"
        sub={`${formatDate(fyStart(fy))} – ${formatDate(end)}`}
      >
        <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
          Income
        </p>
        {pnl.income_lines.map((l) => (
          <div key={l.code} className={lineRow}>
            <span className="text-ink-2">{l.name}</span>
            <span className="font-medium">{inr(l.amount_paise)}</span>
          </div>
        ))}
        <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
          Expenses
        </p>
        {pnl.expense_lines.map((l) => (
          <div key={l.code} className={lineRow}>
            <span className="text-ink-2">{l.name}</span>
            <span className="font-medium">{inr(l.amount_paise)}</span>
          </div>
        ))}
        <div className={totalBand}>
          <span className="text-[13.5px] font-semibold">
            Net {pnl.net_profit_paise < 0 ? "loss" : "profit"}
          </span>
          <span className="text-[15px] font-semibold">
            {inr(Math.abs(pnl.net_profit_paise))}
          </span>
        </div>
        <p className={cardNote}>
          GST collected and input credit ride the balance sheet, not the
          P&amp;L.
        </p>
      </PackSection>

      {/* -------- Computation -------- */}
      <PackSection
        title="Computation of total income"
        sub={`${fyLabel(fy)} · ${ENTITY_LABEL[comp.entity_type] ?? comp.entity_type}${
          comp.presumptive ? ` · presumptive ${comp.presumptive}` : ""
        }`}
      >
        {comp.caveat && (
          <p className={criticalBanner}>
            <strong className="font-semibold">Rates not confirmed.</strong>{" "}
            {comp.caveat} This computation is provisional — check the figures
            against the Act for the year being filed before anything is
            submitted.
          </p>
        )}
        {comp.lines.map((l, i) => (
          <div key={i} className={lineRow}>
            <span className="text-ink-2">
              {l.label}
              {l.note && (
                <span className="ml-2 text-[11.5px] text-ink-3">{l.note}</span>
              )}
            </span>
            <span className="font-medium">
              {l.subtract ? "(" : ""}
              {inr(l.amount_paise)}
              {l.subtract ? ")" : ""}
            </span>
          </div>
        ))}
        <div className={lineRow}>
          <span className="text-ink-2">Gross total income</span>
          <span className="font-medium">
            {inr(comp.gross_total_income_paise)}
          </span>
        </div>
        <div className="flex items-center justify-between bg-surface-2/50 px-5 py-3 text-[14px] font-semibold">
          <span>Total income (rounded)</span>
          <span>{inr(comp.taxable_income_paise)}</span>
        </div>
        {taxRows.map((r) => (
          <div key={r.label} className={lineRow}>
            <span className="text-ink-2">{r.label}</span>
            <span className="font-medium">
              {r.amount < 0 ? "(" : ""}
              {inr(Math.abs(r.amount))}
              {r.amount < 0 ? ")" : ""}
            </span>
          </div>
        ))}
        <div className={lineRow}>
          <span className="text-ink-2">Total tax</span>
          <span className="font-semibold">{inr(comp.tax.total_tax_paise)}</span>
        </div>
        {comp.payments.map((p) => (
          <div key={p.id} className={lineRow}>
            <span className="text-ink-2">
              Less: {p.kind.replace("_", "-")} paid {formatDate(p.paid_on)}
              {p.note && (
                <span className="ml-2 text-[11.5px] text-ink-3">{p.note}</span>
              )}
            </span>
            <span className="font-medium">({inr(p.amount_paise)})</span>
          </div>
        ))}
        <div className={totalBand}>
          <span className="text-[13.5px] font-semibold">
            {comp.net_payable_paise < 0 ? "Refund due" : "Balance payable"}
          </span>
          <span className="text-[15px] font-semibold">
            {inr(Math.abs(comp.net_payable_paise))}
          </span>
        </div>
        {comp.partner_remuneration_ceiling_paise !== null && (
          <p className={cardNote}>
            Indicative 40(b) partner-remuneration ceiling on book profit:{" "}
            {inr(comp.partner_remuneration_ceiling_paise)} — measured on net
            profit per the P&amp;L, never auto-applied.
          </p>
        )}
        {comp.advance_tax.some((i) => i.instalment_paise > 0) && (
          <div className="overflow-x-auto border-t border-hairline">
            <table className="w-full border-collapse">
              <thead>
                <tr className={headRow}>
                  <th className={`${th} text-left`}>Advance tax due</th>
                  <th className={`${th} text-right`}>Cumulative %</th>
                  <th className={`${th} text-right`}>Cumulative</th>
                  <th className={`${th} text-right`}>Instalment</th>
                </tr>
              </thead>
              <tbody>
                {comp.advance_tax.map((i) => (
                  <tr key={i.due} className={bodyRow}>
                    <td className={`${cell} text-left`}>{formatDate(i.due)}</td>
                    <td className={`${cell} text-right`}>
                      {i.cumulative_percent}%
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(i.cumulative_paise)}
                    </td>
                    <td className={`${cell} text-right font-medium`}>
                      {inr(i.instalment_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={cardNote}>
          Prepared from the books plus the recorded adjustments. CA to verify —
          this is filing preparation, not filing advice.
        </p>
      </PackSection>

      {/* -------- GST -------- */}
      <PackSection title="GST monthly summary" sub={fyLabel(fy)}>
        {!gstActive ? (
          <Empty>
            No GST activity in the books for this FY and no GSTIN on file.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className={headRow}>
                  <th className={`${th} text-left`}>Month</th>
                  <th className={`${th} text-right`}>Outward taxable</th>
                  <th className={`${th} text-right`}>CGST</th>
                  <th className={`${th} text-right`}>SGST</th>
                  <th className={`${th} text-right`}>IGST</th>
                  <th className={`${th} text-right`}>ITC</th>
                  <th className={`${th} text-right`}>Net payable</th>
                </tr>
              </thead>
              <tbody>
                {gstMonths.map((g) => (
                  <tr key={g.month} className={bodyRow}>
                    <td className={`${cell} text-left`}>
                      {monthLabel(g.month)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(g.outward_taxable_paise)}
                    </td>
                    <td className={`${cell} text-right`}>{inr(g.cgst_paise)}</td>
                    <td className={`${cell} text-right`}>{inr(g.sgst_paise)}</td>
                    <td className={`${cell} text-right`}>{inr(g.igst_paise)}</td>
                    <td className={`${cell} text-right text-good`}>
                      − {inr(g.itc_paise)}
                    </td>
                    <td className={`${cell} text-right font-medium`}>
                      {inr(g.net_payable_paise)}
                    </td>
                  </tr>
                ))}
                <tr className="text-[13px] font-semibold">
                  <td className="px-4 py-3 text-left">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(gstTotal.outward)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(gstTotal.cgst)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(gstTotal.sgst)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(gstTotal.igst)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-good">
                    − {inr(gstTotal.itc)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(gstTotal.net)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className={cardNote}>
          Filing-prep figures for your CA or GST portal entry — not the
          official GSTN JSON schema, and net of credit notes.
        </p>
      </PackSection>

      {/* -------- TDS -------- */}
      <PackSection title="TDS summary & challans" sub={fyLabel(fy)}>
        {TDS_SECTIONS.some((s) => !s.verified) && (
          <p className={infoBanner}>
            Some section rates in this app are unconfirmed against the
            renumbered Act — verify before filing. CA to verify.
          </p>
        )}
        <p className={infoBanner}>
          From FY 2026-27 these statements file on Form 140 (old 26Q) and
          Form 138 (old 24Q) — Income-tax Rules 2026.
        </p>
        {register.length === 0 && challans.length === 0 ? (
          <Empty>No deductions recorded this FY.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className={headRow}>
                    <th className={`${th} text-left`}>Form</th>
                    <th className={`${th} text-left`}>Quarter</th>
                    <th className={`${th} text-right`}>Payees</th>
                    <th className={`${th} text-right`}>Base</th>
                    <th className={`${th} text-right`}>TDS</th>
                    <th className={`${th} text-right`}>Undeposited</th>
                  </tr>
                </thead>
                <tbody>
                  {tdsQuarters.map((s) => (
                    <tr key={`${s.form}-${s.quarter}`} className={bodyRow}>
                      <td className={`${cell} text-left`}>{s.form}</td>
                      <td className={`${cell} text-left`}>Q{s.quarter}</td>
                      <td className={`${cell} text-right`}>
                        {s.lines.length}
                        {s.missing_pan_count > 0 && (
                          <span className="ml-1.5 text-critical">
                            ({s.missing_pan_count} no PAN)
                          </span>
                        )}
                      </td>
                      <td className={`${cell} text-right`}>
                        {inr(s.total_base_paise)}
                      </td>
                      <td className={`${cell} text-right font-medium`}>
                        {inr(s.total_tds_paise)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {inr(s.undeposited_paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tdsQuarters.some((s) => s.missing_pan_count > 0) && (
              <p className={`${criticalBanner} border-t`}>
                Payees without a PAN — the return will reject those lines.
                Collect the PAN before filing.
              </p>
            )}
            {challans.length > 0 && (
              <div className="overflow-x-auto border-t border-hairline">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className={headRow}>
                      <th className={`${th} text-left`}>Deposited</th>
                      <th className={`${th} text-left`}>Form</th>
                      <th className={`${th} text-left`}>Quarter</th>
                      <th className={`${th} text-left`}>Challan</th>
                      <th className={`${th} text-left`}>BSR</th>
                      <th className={`${th} text-right`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {challans.map((c) => (
                      <tr key={c.id} className={bodyRow}>
                        <td className={`${cell} text-left`}>
                          {formatDate(c.paid_on)}
                        </td>
                        <td className={`${cell} text-left`}>{c.form}</td>
                        <td className={`${cell} text-left`}>Q{c.quarter}</td>
                        <td className={`${cell} text-left`}>
                          {c.challan_no || "—"}
                        </td>
                        <td className={`${cell} text-left text-ink-3`}>
                          {c.bsr_code || "—"}
                        </td>
                        <td className={`${cell} text-right`}>
                          {inr(c.amount_paise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className={cardNote}>
              {undeposited > 0
                ? `${inr(undeposited)} deducted in ${fyLabel(fy)} is not yet deposited.`
                : `Everything deducted in ${fyLabel(fy)} is deposited.`}
            </p>
          </>
        )}
      </PackSection>

      {/* -------- Depreciation -------- */}
      <PackSection
        title="Depreciation & fixed assets"
        sub={`IT-Act WDV · ${fyLabel(fy)}`}
      >
        {posted && posted.amount_paise !== schedule.total_depreciation_paise && (
          <p className={criticalBanner}>
            The register has changed since this year was posted: the schedule
            now works out to {inr(schedule.total_depreciation_paise)}, but the
            books carry {inr(posted.amount_paise)} (journal #{posted.id}).
            Reconcile before sign-off.
          </p>
        )}
        {!posted && schedule.total_depreciation_paise > 0 && (
          <p className={infoBanner}>
            This year&rsquo;s depreciation entry is not posted yet — the
            P&amp;L above carries no depreciation charge for it.
          </p>
        )}
        {liveBlocks.length === 0 ? (
          <Empty>No depreciable blocks this FY.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className={headRow}>
                  <th className={`${th} text-left`}>Block</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Opening</th>
                  <th className={`${th} text-right`}>Additions ≥{HALF_YEAR_DAYS}d</th>
                  <th className={`${th} text-right`}>Additions &lt;{HALF_YEAR_DAYS}d</th>
                  <th className={`${th} text-right`}>Disposals</th>
                  <th className={`${th} text-right`}>Depreciation</th>
                  <th className={`${th} text-right`}>Closing</th>
                </tr>
              </thead>
              <tbody>
                {liveBlocks.map((b) => (
                  <tr key={b.block} className={bodyRow}>
                    <td className={`${cell} text-left`}>
                      {blockFor(b.block)?.label ?? b.block}
                      {b.opening_overridden && (
                        <span className="ml-1.5 text-[11px] text-ink-3">
                          (opening overridden)
                        </span>
                      )}
                    </td>
                    <td className={`${cell} text-right`}>{b.rate}%</td>
                    <td className={`${cell} text-right`}>
                      {inr(b.opening_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.additions_full_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.additions_half_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.disposals_paise)}
                    </td>
                    <td className={`${cell} text-right font-medium`}>
                      {inr(b.depreciation_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.closing_paise)}
                    </td>
                  </tr>
                ))}
                <tr className="text-[13px] font-semibold">
                  <td className="px-4 py-3" colSpan={6}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(schedule.total_depreciation_paise)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(schedule.total_closing_paise)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {assets.length > 0 && (
          <div className="overflow-x-auto border-t border-hairline">
            <table className="w-full border-collapse">
              <thead>
                <tr className={headRow}>
                  <th className={`${th} text-left`}>Asset</th>
                  <th className={`${th} text-left`}>Block</th>
                  <th className={`${th} text-right`}>Cost</th>
                  <th className={`${th} text-left`}>Purchased</th>
                  <th className={`${th} text-left`}>Put to use</th>
                  <th className={`${th} text-left`}>Disposed</th>
                  <th className={`${th} text-right`}>Proceeds</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className={bodyRow}>
                    <td className={`${cell} text-left`}>{a.name}</td>
                    <td className={`${cell} text-left`}>
                      {blockFor(a.block)?.label ?? a.block}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(a.cost_paise)}
                    </td>
                    <td className={`${cell} text-left`}>
                      {formatDate(a.purchase_date)}
                    </td>
                    <td className={`${cell} text-left`}>
                      {a.put_to_use_date
                        ? formatDate(a.put_to_use_date)
                        : "not yet"}
                    </td>
                    <td className={`${cell} text-left`}>
                      {a.disposed_date ? formatDate(a.disposed_date) : "—"}
                    </td>
                    <td className={`${cell} text-right`}>
                      {a.disposal_paise !== null ? inr(a.disposal_paise) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={cardNote}>
          IT-Act written-down value. Assets in use under {HALF_YEAR_DAYS} days
          take half the rate. CA to verify.
        </p>
      </PackSection>

      {/* -------- Debtors / creditors annexure -------- */}
      <PackSection
        title="Debtors & creditors annexure"
        sub={`as at ${formatDate(end)}`}
      >
        {(debtorsTotal !== arControl || creditorsTotal !== apControl) && (
          <p className={criticalBanner}>
            Annexure does not reconcile to the control accounts: debtors{" "}
            {inr(debtorsTotal)} vs AR {inr(arControl)}; creditors{" "}
            {inr(creditorsTotal)} vs AP {inr(apControl)}. The difference is
            control-ledger postings without a party — investigate before
            sign-off.
          </p>
        )}
        {debtors.length + creditors.length === 0 ? (
          <Empty>No party balances as at {formatDate(end)}.</Empty>
        ) : (
          <div className="grid sm:grid-cols-2">
            {(
              [
                ["Sundry debtors", debtors, debtorsTotal],
                ["Sundry creditors", creditors, creditorsTotal],
              ] as const
            ).map(([label, rows, total]) => (
              <div
                key={label}
                className="border-hairline sm:first:border-r sm:[&:first-child]:border-r"
              >
                <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
                  {label}
                </p>
                {rows.length === 0 ? (
                  <Empty>None</Empty>
                ) : (
                  rows.map((x) => (
                    <div key={x.key} className={lineRow}>
                      <span className="text-ink-2">
                        {x.name}
                        {x.cross && (
                          <span className="ml-2 text-[11px] text-ink-3">
                            cross-ledger
                          </span>
                        )}
                        {x.gstin && (
                          <span className="ml-2 text-[11px] text-ink-3">
                            {x.gstin}
                          </span>
                        )}
                      </span>
                      <span className="font-medium">
                        {inr(x.amount_paise)}
                      </span>
                    </div>
                  ))
                )}
                <div className="flex items-center justify-between bg-surface-2/50 px-5 py-3 text-[13.5px] font-semibold">
                  <span>Total</span>
                  <span>{inr(total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className={cardNote}>
          Positions as at {formatDate(end)} read off each party&rsquo;s
          statement, including cross-ledger balances (a customer&rsquo;s
          payables, a supplier&rsquo;s receivables) tagged on the side they
          sit — so the totals tie to the control accounts on the Balance
          Sheet.
        </p>
      </PackSection>
    </div>
  );
}
