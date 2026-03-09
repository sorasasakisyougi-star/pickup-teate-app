import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "pickup-teate-app",
  description: "pickup-teate-app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
