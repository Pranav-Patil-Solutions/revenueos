"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "./db";

export async function createParty(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  const gstin = String(formData.get("gstin") ?? "").trim().toUpperCase();
  const stateCode = String(formData.get("state_code") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  if (!name) throw new Error("Party name is required.");
  if (kind !== "customer" && kind !== "supplier") {
    throw new Error("Party kind must be customer or supplier.");
  }
  getDb()
    .prepare(
      `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, kind, gstin, stateCode, phone, new Date().toISOString());
  revalidatePath("/parties");
  redirect("/parties");
}

export async function updateSettings(formData: FormData): Promise<void> {
  const rate = Number(formData.get("default_gst_rate") ?? 18);
  getDb()
    .prepare(
      `UPDATE settings SET
         company_name = ?, gstin = ?, state_code = ?, country = ?,
         currency = ?, default_gst_rate = ?, tax_inclusive = ?
       WHERE id = 1`
    )
    .run(
      String(formData.get("company_name") ?? "").trim() || "My Company",
      String(formData.get("gstin") ?? "").trim().toUpperCase(),
      String(formData.get("state_code") ?? "").trim(),
      String(formData.get("country") ?? "IN").trim().toUpperCase() || "IN",
      String(formData.get("currency") ?? "INR").trim().toUpperCase() || "INR",
      Number.isFinite(rate) ? rate : 18,
      formData.get("tax_inclusive") === "on" ? 1 : 0
    );
  revalidatePath("/settings");
  redirect("/settings");
}
