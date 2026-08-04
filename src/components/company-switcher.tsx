"use client";

import { useRef } from "react";
import Link from "next/link";
import { switchCompany } from "@/lib/actions";

/** Topbar company picker — RVOS-004 P3. A plain form so it still works with
 * JavaScript disabled (the select alone submits nothing without it; the
 * "Manage companies" link is the fallback path in that case). Auto-submits on
 * change so switching is one action, not select-then-click. */
export function CompanySwitcher({
  current,
  companies,
}: {
  current: { id: number; name: string } | null;
  companies: { id: number; name: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);

  if (companies.length === 0) {
    return (
      <Link href="/companies" className="pill">
        Add a company
      </Link>
    );
  }

  return (
    <form ref={formRef} action={switchCompany} className="flex items-center gap-1.5">
      <select
        name="company_id"
        defaultValue={current?.id ?? ""}
        aria-label="Active company"
        onChange={() => formRef.current?.requestSubmit()}
        className="rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[13px] font-semibold tracking-tight text-ink outline-none focus:border-accent"
      >
        {!current && <option value="" disabled>Select a company…</option>}
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Link href="/companies" className="text-[11.5px] text-ink-3 hover:text-ink" title="Manage companies">
        Manage
      </Link>
    </form>
  );
}
