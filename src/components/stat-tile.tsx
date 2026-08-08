interface StatTileProps {
  label: string;
  value: string;
  /** Quiet line under the figure — what it counts, or what it is as of. */
  sub?: string;
}

export function StatTile({ label, value, sub }: StatTileProps) {
  return (
    <div className="card p-5">
      <p className="text-[12.5px] font-medium text-ink-3">{label}</p>
      <p
        className="mt-2 text-[26px] font-semibold leading-none tracking-tight"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </p>
      {sub && <p className="mt-2 text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}
