"use client";

import { useState } from "react";
import type { DocumentStatusSlice } from "@/lib/reports";
import type { DocumentStatus } from "@/lib/types";

const R = 46;
const CIRC = 2 * Math.PI * R;

/** Pipeline-stage hues, matching StatusBadge so a status means the same
 * colour wherever it appears. */
const TONE: Record<DocumentStatus, { stroke: string; label: string }> = {
  posted: { stroke: "var(--status-good)", label: "Posted" },
  extracted: { stroke: "var(--accent)", label: "Needs review" },
  uploaded: { stroke: "var(--status-warning)", label: "Uploaded" },
  extracting: { stroke: "var(--baseline)", label: "Extracting" },
  failed: { stroke: "var(--status-critical)", label: "Failed" },
};

export function DonutChart({ slices }: { slices: DocumentStatusSlice[] }) {
  const [hi, setHi] = useState<DocumentStatus | null>(null);
  const total = slices.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return (
      <p className="px-1 py-6 text-center text-[12.5px] text-ink-3">
        No documents captured yet.
      </p>
    );
  }

  // Each arc starts where the ones before it end, so the offset is the
  // running sum of preceding counts — derived, never accumulated in place.
  const arcs = slices.map((s, i) => {
    const preceding = slices.slice(0, i).reduce((n, p) => n + p.count, 0);
    return {
      ...s,
      len: (s.count / total) * CIRC,
      offset: (preceding / total) * CIRC,
    };
  });

  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 120 120" className="size-[120px] shrink-0" aria-hidden="true">
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth="15"
        />
        <g transform="rotate(-90 60 60)">
          {arcs.map((a) => (
            <circle
              key={a.status}
              className="donut-seg"
              data-dim={hi !== null && hi !== a.status}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke={TONE[a.status].stroke}
              strokeWidth="15"
              strokeDasharray={`${a.len} ${CIRC - a.len}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </g>
        <text
          x="60"
          y="57"
          textAnchor="middle"
          fontSize="21"
          fontWeight="600"
          fill="var(--ink)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {total}
        </text>
        <text x="60" y="73" textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">
          Total
        </text>
      </svg>

      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {arcs.map((a) => (
          <li
            key={a.status}
            className="legend-row flex items-center gap-2 px-1.5 py-1 text-[12.5px]"
            data-hi={hi === a.status}
            onPointerEnter={() => setHi(a.status)}
            onPointerLeave={() => setHi(null)}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: TONE[a.status].stroke }}
            />
            <span className="flex-1 truncate text-ink-2">{TONE[a.status].label}</span>
            <span
              className="font-medium text-ink"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {a.count}{" "}
              <span className="font-normal text-ink-3">
                ({Math.round((a.count / total) * 100)}%)
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
