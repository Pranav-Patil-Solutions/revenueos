/** Rupee number (e.g. from extraction JSON) → integer paise. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer paise → "₹12,580.00" with Indian digit grouping. */
export function inr(paise: number): string {
  return inrFmt.format(paise / 100);
}

/** Paise → plain "12580.00" for CSV/JSON exports (no symbol, no grouping). */
export function paiseToRupeeString(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ISO date "2026-07-02" → "02 Jul 2026". Manual formatting — no timezone
 * surprises with date-only strings. Null/invalid → "—". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${m[3]} ${month.slice(0, 3)} ${m[1]}` : iso;
}

/** "2026-07" → "July 2026". */
export function monthLabel(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return `${MONTHS[Number(m[2]) - 1] ?? month} ${m[1]}`;
}

/** Local date as ISO YYYY-MM-DD. */
export function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Current month as YYYY-MM. */
export function thisMonth(): string {
  return todayIso().slice(0, 7);
}

/** ISO timestamp → "02 Jul 2026, 14:05" in local time. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${day} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** RFC-4180-ish CSV: quote when a cell contains comma, quote, or newline. */
export function toCsv(
  headers: string[],
  rows: (string | number | null)[][]
): string {
  const cell = (v: string | number | null): string => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
