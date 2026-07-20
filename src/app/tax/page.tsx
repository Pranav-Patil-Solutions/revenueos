import { redirect } from "next/navigation";

/** Tax & filing landing. Depreciation is the first tab that ships; P7 moves
 * this to /tax/computation once the computation page exists. */
export default function TaxPage() {
  redirect("/tax/depreciation");
}
