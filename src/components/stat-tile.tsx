interface StatTileProps {
  label: string;
  value: string;
  delta?: { value: string; positive: boolean };
  deltaLabel?: string;
  trend?: number[]; // ~12 points; last point rendered in the accent
}

function Sparkline({ points }: { points: number[] }) {
  const w = 96;
  const h = 28;
  const pad = 3;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const xy = points.map((p, i) => [
    pad + i * step,
    pad + (h - pad * 2) * (1 - (p - min) / range),
  ]);
  const d = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-7 w-24"
      aria-hidden="true"
    >
      {/* history in the de-emphasis hue; current period marked in the accent */}
      <path
        d={d}
        fill="none"
        stroke="var(--baseline)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lx} cy={ly} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

export function StatTile({ label, value, delta, deltaLabel, trend }: StatTileProps) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <p className="text-[12.5px] font-medium text-ink-3">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-[26px] font-semibold leading-none tracking-tight" style={{ fontVariantNumeric: "tabular-nums" }}>
          {value}
        </p>
        {trend && trend.length > 1 && <Sparkline points={trend} />}
      </div>
      {delta && (
        <p className="mt-2.5 text-[12px] text-ink-3">
          <span
            className={delta.positive ? "font-medium text-good" : "font-medium text-critical"}
          >
            {delta.value}
          </span>{" "}
          {deltaLabel ?? "vs previous 30 days"}
        </p>
      )}
    </div>
  );
}
