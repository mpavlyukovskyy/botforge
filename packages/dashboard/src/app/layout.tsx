import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BotForge Dashboard",
  description: "Fleet management dashboard for BotForge agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
          <h1 className="text-lg font-bold">BotForge</h1>
          <a href="/" className="text-sm text-gray-400 hover:text-white">Fleet</a>
          <a href="/logs" className="text-sm text-gray-400 hover:text-white">Logs</a>
          <a href="/settings" className="text-sm text-gray-400 hover:text-white">Settings</a>
        </nav>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
