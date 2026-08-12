import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Shortcuts } from "@/components/shortcuts";
import { Sidebar } from "@/components/sidebar";
import { Statusbar } from "@/components/statusbar";
import { Topbar } from "@/components/topbar";
import { getSessionUser } from "@/lib/dal";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RevenueOS — Finance department in a box",
  description:
    "Photograph a ledger page, review the extracted rows, post to proper double-entry books, and get statements plus GST filing prep.",
};

/**
 * Restore the persisted sidebar state before first paint (no flash).
 *
 * This is a PLAIN `<script>`, deliberately, not `next/script`.
 *
 * `next/script` is a client component, and its `beforeInteractive` inline
 * branch does not emit this code as a script the browser runs while parsing:
 * it emits a script that pushes the source onto Next's `self.__next_s` queue,
 * which the framework runtime drains after the document is already up. For a
 * "before first paint" job that is too late by definition — the sidebar paints
 * at 310px and snaps to 72px. It also renders a `<script>` element from a
 * client component, which is what React 19 is warning about: on any client
 * render that tag is inert.
 *
 * Rendered from a Server Component into the top of <body>, this executes
 * synchronously during parse — before the sidebar markup below it exists —
 * which is the only thing that actually removes the flash.
 */
const SIDEBAR_BOOT = `try{if(localStorage.getItem("revenueos.sidebar")==="rail")document.documentElement.dataset.sidebar="rail"}catch(e){}`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /**
   * The chrome is rendered only for a signed-in user.
   *
   * This is NOT the authorization check — pages guard themselves via the DAL,
   * because a layout does not re-render on navigation and so cannot be relied
   * on to re-check anything. This is presentation: the Topbar prints the
   * company name, GSTIN, FY and books-lock state, and none of that should be
   * legible to someone sitting on the login page who has not signed in.
   */
  const user = await getSessionUser();

  if (!user) {
    return (
      <html
        lang="en"
        suppressHydrationWarning
        className={`${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full">{children}</body>
      </html>
    );
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
        <Sidebar />
        <div className="content-shell min-h-screen">
          <Topbar username={user.username} companyId={user.companyId} />
          <main className="mx-auto max-w-6xl px-8 pt-8 pb-16">{children}</main>
        </div>
        <Statusbar />
        <Shortcuts />
      </body>
    </html>
  );
}
