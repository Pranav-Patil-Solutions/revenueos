import type { DocumentStatus } from "@/lib/types";

const STYLES: Record<string, { dot: string; label: string }> = {
  uploaded: { dot: "bg-warning", label: "Uploaded" },
  extracting: { dot: "bg-accent", label: "Extracting" },
  extracted: { dot: "bg-accent", label: "Needs review" },
  posted: { dot: "bg-good", label: "Posted" },
  failed: { dot: "bg-critical", label: "Failed" },
};

export function StatusBadge({ status }: { status: DocumentStatus | string }) {
  const s = STYLES[status] ?? { dot: "bg-baseline", label: status };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2">
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/** Extraction confidence pill — warning tint under 0.7, critical under 0.4. */
export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence < 0.4
      ? "text-critical border-critical/40"
      : confidence < 0.7
        ? "text-warning border-warning/40"
        : "text-ink-3 border-hairline";
  return (
    <span
      className={`inline-flex rounded-full border bg-surface-2 px-2 py-0.5 text-[11px] font-medium tabular-nums ${tone}`}
    >
      {pct}%
    </span>
  );
}
