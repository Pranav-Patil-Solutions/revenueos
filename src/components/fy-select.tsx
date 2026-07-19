import { fyLabel } from "@/lib/fy";

/** FY dropdown for report filters — pure server markup, submits with the
 * surrounding GET form. Pass allowBlank for "no FY filter" (month/all-time). */
export function FySelect({
  fys,
  value,
  name = "fy",
  allowBlank = false,
  blankLabel = "All / by month",
}: {
  fys: string[];
  value?: string;
  name?: string;
  allowBlank?: boolean;
  blankLabel?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      aria-label="Financial year"
      className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
    >
      {allowBlank && <option value="">{blankLabel}</option>}
      {fys.map((fy) => (
        <option key={fy} value={fy}>
          {fyLabel(fy)}
        </option>
      ))}
    </select>
  );
}
