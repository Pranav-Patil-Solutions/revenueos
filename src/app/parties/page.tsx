export default function PartiesPage() {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Parties</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Customers and suppliers whose ledgers you keep.
      </p>
      <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
        <p className="text-[13.5px] font-medium text-ink-2">No parties yet</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Add a customer or supplier and their statement will build itself.
        </p>
      </div>
    </div>
  );
}
