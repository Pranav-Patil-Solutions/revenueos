import { NextResponse } from "next/server";
import { toCsv } from "@/lib/format";
import { TEMPLATE_HEADERS } from "@/lib/import-csv";
import { requireApiSession } from "@/lib/dal";

/** The fill-in CSV template, with example rows demonstrating the khata
 * convention: sales/receivables in debit, purchases/receipts in credit,
 * amounts in rupees, party by exact name. */
export async function GET() {
  const gate = await requireApiSession();
  if (gate instanceof Response) return gate;
  const csv = toCsv(
    [...TEMPLATE_HEADERS],
    [
      ["2026-07-02", "Cloth bill #241", "241", "Sharma Traders", "sale", "11800", "", "18", "cash"],
      ["2026-07-05", "Cash received", "", "Sharma Traders", "receipt", "", "7000", "", "cash"],
      ["2026-07-14", "Packing material inv 88", "88", "Gupta Suppliers", "purchase", "", "5900", "18", "bank"],
    ]
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="revenueos-import-template.csv"',
    },
  });
}
