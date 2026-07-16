import Link from "next/link";

export default function NotFound() {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-6 py-16 text-center">
      <p className="text-[15px] font-semibold">Not found</p>
      <p className="mt-1 text-[13px] text-ink-3">
        This page, document, or party doesn&apos;t exist (it may have been deleted).
      </p>
      <Link
        href="/"
        className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
      >
        Back to Overview
      </Link>
    </div>
  );
}
