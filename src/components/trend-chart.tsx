"use client";

import { useRef, useState } from "react";
import { inr, monthLabel } from "@/lib/format";
import type { TrendPoint } from "@/lib/reports";

const W = 460;
const H = 170;
const PAD_X = 10;

/** Receivables closing balance over time. The y-axis is anchored at zero and
 * scaled to the peak, so the slope reads as real growth rather than as the
 * artefact of a floating baseline. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  if (points.length < 2) {
    return (
      <div className="grid h-[170px] place-items-center text-[12.5px] text-ink-3">
        Not enough history yet — the trend appears once two months are posted.
      </div>
    );
  }

  const values = points.map((p) => p.closing_paise);
  // Zero is always in frame, but it is the FLOOR only when nothing is negative.
  // A net credit on the AR control (customer advances) is a real position, and
  // scaling from an assumed zero floor would push those points outside the
  // viewBox, where the SVG clips them and the line silently disappears.
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const step = (W - PAD_X * 2) / (points.length - 1);
  const xy = values.map((v, i) => {
    const x = PAD_X + i * step;
    const y = H - 12 - (H - 34) * ((v - lo) / span);
    return [x, y] as const;
  });

  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${xy[xy.length - 1][0]},${H} L${xy[0][0]},${H} Z`;
  const active = hover === null ? null : points[hover];

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const rel = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < xy.length; i++) {
      if (Math.abs(xy[i][0] - rel) < Math.abs(xy[best][0] - rel)) best = i;
    }
    setHover(best);
  };

  return (
    <div onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <div ref={wrap} className="relative" style={{ height: H }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Receivables trend: ${points
          .map((p) => `${monthLabel(p.month)} ${inr(p.closing_paise)}`)
          .join(", ")}`}
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={12 + (H - 34) * f}
            y2={12 + (H - 34) * f}
            stroke="var(--grid)"
            strokeWidth="1"
          />
        ))}

        <path d={area} fill="url(#trend-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {active && (
          <line
            x1={xy[hover as number][0]}
            x2={xy[hover as number][0]}
            y1="6"
            y2={H}
            stroke="var(--baseline)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}

        {xy.map(([x, y], i) => (
          <circle
            key={points[i].month}
            cx={x}
            cy={y}
            r={hover === i ? 6 : i === xy.length - 1 ? 5 : 4}
            fill="var(--surface)"
            stroke="var(--accent)"
            strokeWidth="2.5"
          />
        ))}
      </svg>

      {active && (
        <div
          className="viz-tip"
          style={{
            // Percentages, so the readout tracks the point whatever the
            // rendered size is — the SVG stretches, its user units do not.
            left: `${(xy[hover as number][0] / W) * 100}%`,
            top: `${(xy[hover as number][1] / H) * 100}%`,
          }}
        >
          {monthLabel(active.month)} · {inr(active.closing_paise)}
        </div>
      )}
      </div>

      <div className="mt-1 flex justify-between px-1 text-[11.5px] text-ink-3">
        {points.map((p) => (
          <span key={p.month}>{monthLabel(p.month).slice(0, 3)}</span>
        ))}
      </div>
    </div>
  );
}
