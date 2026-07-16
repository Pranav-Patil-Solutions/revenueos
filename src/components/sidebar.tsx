"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  {
    href: "/",
    label: "Overview",
    icon: (
      <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
    ),
  },
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
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-hairline bg-surface">
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-8">
        <span className="grid size-8 place-items-center rounded-lg bg-accent-soft">
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
        <span className="text-[15px] font-semibold tracking-tight">
          Revenue<span className="text-accent">OS</span>
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${
                active
                  ? "bg-surface-2 text-ink"
                  : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className={`size-4 ${active ? "stroke-accent" : "stroke-current"}`}
                fill="none"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {item.icon}
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-hairline px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
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
