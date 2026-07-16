export default function DocumentsPage() {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Documents</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Every captured ledger page and where it is in the pipeline.
      </p>
      <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-ink-2">No documents yet</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Capture a ledger page and it will land here.
        </p>
      </div>
    </div>
  );
}
