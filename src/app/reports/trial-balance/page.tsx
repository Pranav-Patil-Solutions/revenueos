export default function TrialBalancePage() {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Trial balance</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Every account&apos;s net position — debits must equal credits.
      </p>
      <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-ink-2">Trial balance coming online</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Post a document and the balances land here.
        </p>
      </div>
    </div>
  );
}
