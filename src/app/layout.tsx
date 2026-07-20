import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Shortcuts } from "@/components/shortcuts";
import { Sidebar } from "@/components/sidebar";
import { Statusbar } from "@/components/statusbar";
import { Topbar } from "@/components/topbar";
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

// Restore the persisted sidebar state before first paint (no flash).
const SIDEBAR_BOOT = `try{if(localStorage.getItem("revenueos.sidebar")==="rail")document.documentElement.dataset.sidebar="rail"}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
          <Topbar />
          <main className="mx-auto max-w-6xl px-8 pt-8 pb-16">{children}</main>
        </div>
        <Statusbar />
        <Shortcuts />
      </body>
    </html>
  );
}
