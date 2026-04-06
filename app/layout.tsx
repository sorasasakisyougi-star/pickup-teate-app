import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "pickup-teate-app",
  description: "pickup-teate-app",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#020817",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="antialiased min-h-screen flex flex-col">
        <nav className="bg-slate-900 border-b border-slate-800 px-6 py-3 shrink-0 flex items-center justify-between">
          <div className="text-white font-bold text-lg">pickup-teate-app</div>
          <div className="flex gap-4">
            <a href="/" className="text-slate-300 hover:text-white transition-colors text-sm">Home</a>
            <a href="/agri-jobs" className="text-emerald-400 hover:text-emerald-300 font-medium transition-colors text-sm">農業求人ダッシュボード</a>
          </div>
        </nav>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
