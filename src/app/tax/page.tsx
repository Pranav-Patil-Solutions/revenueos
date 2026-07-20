import { redirect } from "next/navigation";

/** Tax & filing landing — the computation is what the office opens the section
 * for; depreciation and TDS feed it. */
export default function TaxPage() {
  redirect("/tax/computation");
}
