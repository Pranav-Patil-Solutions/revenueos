import { redirect } from "next/navigation";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  await requireSession();

  redirect("/reports/gst");
}
