"use client";

import { useActionState } from "react";
import { createFirstUser, login, type LoginState } from "@/lib/auth-actions";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export function LoginForm({
  firstRun,
  next,
}: {
  firstRun: boolean;
  next: string;
}) {
  const action = firstRun ? createFirstUser : login;
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    action,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {!firstRun && <input type="hidden" name="next" value={next} />}

      <div>
        <label className={label} htmlFor="username">
          Username
        </label>
        <input
          id="username"
          name="username"
          className={field}
          autoComplete="username"
          autoFocus
          required
        />
      </div>

      <div>
        <label className={label} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className={field}
          autoComplete={firstRun ? "new-password" : "current-password"}
          required
        />
        {firstRun && (
          <p className="mt-1.5 text-[12px] text-ink-3">
            At least 10 characters, with a letter and a number.
          </p>
        )}
      </div>

      {firstRun && (
        <div>
          <label className={label} htmlFor="confirm">
            Confirm password
          </label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            className={field}
            autoComplete="new-password"
            required
          />
        </div>
      )}

      {state?.error && (
        <p
          role="alert"
          className="rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-[12.5px] text-critical"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-lg bg-accent px-3 py-2 text-[13.5px] font-medium text-white transition hover:brightness-110 active:scale-[.98] disabled:opacity-50"
      >
        {pending
          ? firstRun
            ? "Creating…"
            : "Signing in…"
          : firstRun
            ? "Create account"
            : "Sign in"}
      </button>
    </form>
  );
}
