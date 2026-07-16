export default async function PartyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Party</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">Party {id}</p>
      <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-ink-2">Statement coming online</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          The running-balance statement lands here in a later phase.
        </p>
      </div>
    </div>
  );
}
