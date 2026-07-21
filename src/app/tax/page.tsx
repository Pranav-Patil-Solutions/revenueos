import { redirect } from "next/navigation";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

/** Tax & filing landing — the computation is what the office opens the section
 * for; depreciation and TDS feed it. */
export default async function TaxPage() {
  await requireSession();

  redirect("/tax/computation");
}
