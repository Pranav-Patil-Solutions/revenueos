"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "revenueos.sidebar";

type NavItem = { href: string; label: string; icon: React.ReactNode };
type NavGroup = { header: string | null; items: NavItem[] };

// Workflow-ordered IA. Vouchers/Imports/Tax/Compliance/CA pack join their
// groups as those phases ship.
const NAV_GROUPS: NavGroup[] = [
  {
    header: null,
    items: [
      {
        href: "/",
        label: "Overview",
        icon: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
      },
    ],
  },
  {
    header: "1 · Ledger entry",
    items: [
      {
        href: "/capture",
        label: "Capture",
        icon: (
          <>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </>
        ),
      },
      {
        href: "/vouchers",
        label: "Vouchers",
        icon: (
          <>
            <path d="M4 4h16v16H4z" />
            <path d="M8 9h8M8 13h5M4 4l2 2 2-2 2 2 2-2 2 2 2-2 2 2" />
          </>
        ),
      },
      {
        href: "/imports",
        label: "Imports",
        icon: (
          <>
            <path d="M12 3v10M7 8l5 5 5-5" />
            <path d="M4 17v3h16v-3" />
          </>
        ),
      },
    ],
  },
  {
    header: "2 · Books",
    items: [
      {
        href: "/documents",
        label: "Documents",
        icon: (
          <>
            <path d="M7 3h7l4 4v14H7z" />
            <path d="M14 3v4h4M10 12h5M10 16h5" />
          </>
        ),
      },
      {
        href: "/parties",
        label: "Parties",
        icon: (
          <>
            <circle cx="9" cy="8" r="3.5" />
            <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
            <path d="M16 5a3.5 3.5 0 0 1 0 7M17.5 15.5a5.5 5.5 0 0 1 3 4.5" />
          </>
        ),
      },
    ],
  },
  {
    header: "3 · Statements",
    items: [
      {
        href: "/reports",
        label: "Reports",
        icon: (
          <>
            <path d="M3 3v18h18" />
            <path d="M7 14l3-4 3 3 4-6" />
          </>
        ),
      },
    ],
  },
  {
    header: "4 · Tax & filing",
    items: [
      {
        href: "/tax",
        label: "Tax",
        icon: (
          <>
            <path d="M6 3h9l4 4v14H6z" />
            <path d="M15 3v4h4M10 12h5M10 16h3M9.5 8.5h1" />
          </>
        ),
      },
      {
        href: "/compliance",
        label: "Compliance",
        icon: (
          <>
            <path d="M4 6h16v14H4z" />
            <path d="M8 3v4M16 3v4M4 11h16" />
            <path d="M9 16l2 2 4-4" />
          </>
        ),
      },
    ],
  },
  {
    header: null,
    items: [
      {
        href: "/settings",
        label: "Settings",
        icon: (
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </>
        ),
      },
    ],
  },
];

function isRail(): boolean {
  return document.documentElement.dataset.sidebar === "rail";
}

export function Sidebar() {
  const pathname = usePathname();
  const [peek, setPeek] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = useCallback(() => {
    const html = document.documentElement;
    const rail = !isRail();
    if (rail) html.dataset.sidebar = "rail";
    else delete html.dataset.sidebar;
    try {
      localStorage.setItem(STORAGE_KEY, rail ? "rail" : "open");
    } catch {}
    setPeek(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Hover-to-peek: intent delay in (~90ms), lazy out (~220ms) to kill flicker.
  const onEnter = () => {
    if (!isRail()) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setPeek(true), 90);
  };
  const onLeave = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setPeek(false), 220);
  };

  return (
    <aside
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className={`sidebar fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden whitespace-nowrap border-r border-hairline bg-surface ${
        peek ? "peek" : ""
      }`}
    >
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-6">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft">
          <svg
            viewBox="0 0 24 24"
            className="size-4.5 stroke-accent"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
            <path d="M9 7h6M9 11h6" />
          </svg>
        </span>
        <span className="side-label text-[15px] font-semibold tracking-tight">
          Revenue<span className="text-accent">OS</span>
        </span>
      </div>

      <nav className="flex flex-1 flex-col px-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col gap-0.5">
            {group.header && (
              <p className="side-header mt-4 mb-1 px-3 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-3">
                {group.header}
              </p>
            )}
            {group.items.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`side-item flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium ${
                    active
                      ? "bg-accent text-white"
                      : "text-ink-2 hover:bg-surface-2/70 hover:text-ink"
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 shrink-0 stroke-current"
                    fill="none"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {item.icon}
                  </svg>
                  <span className="side-label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={toggle}
        className="side-item mx-3 mb-2 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-3 hover:bg-surface-2/70 hover:text-ink"
        title="Collapse sidebar (Ctrl+B)"
      >
        <svg
          viewBox="0 0 24 24"
          className="side-chevron size-4 shrink-0 stroke-current transition-transform duration-300"
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
        <span className="side-label">
          Collapse <span className="text-ink-3">· ⌃B</span>
        </span>
      </button>

      <div className="side-user border-t border-hairline px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
            PP
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">Pranav Patil</p>
            <p className="truncate text-[11.5px] text-ink-3">Books owner</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
