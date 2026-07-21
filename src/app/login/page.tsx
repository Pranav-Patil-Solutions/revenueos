import { getDb } from "@/lib/db";
import { userCount } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

/**
 * The only page reachable without a session (see PUBLIC_PATHS in src/proxy.ts).
 *
 * On a machine with no accounts yet it becomes the first-run form instead of a
 * sign-in form. Nothing is seeded: the app ships with NO default credentials,
 * because an "admin/admin" that someone forgets to change is worse than no
 * auth — it looks secure.
 */
export default async function LoginPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise and must be awaited (AGENTS.md).
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const firstRun = userCount(getDb()) === 0;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-[340px]">
        <div className="mb-7">
          <h1 className="text-[26px] font-semibold tracking-[-0.005em] text-ink">
            {firstRun ? "Set up RevenueOS" : "RevenueOS"}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-3">
            {firstRun
              ? "Create the account that will open the books on this machine."
              : "Sign in to open the books."}
          </p>
        </div>

        <div className="rounded-xl border border-hairline bg-surface p-5">
          <LoginForm firstRun={firstRun} next={next ?? "/"} />
        </div>

        <p className="mt-5 text-center text-[11.5px] leading-relaxed text-ink-3">
          This machine holds the books. Anyone who can reach it on the tailnet
          needs an account — Tailscale is no longer the only thing in the way.
        </p>
      </div>
    </main>
  );
}
