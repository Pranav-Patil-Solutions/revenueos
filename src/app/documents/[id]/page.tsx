export default async function DocumentReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Review</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">Document {id}</p>
      <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-ink-2">Review coming online</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Extracted rows and the ledger photo land here in a later phase.
        </p>
      </div>
    </div>
  );
}
