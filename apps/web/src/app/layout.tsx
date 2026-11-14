import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Taxi Notebook",
  description: "Explore NYC taxi trips together: ask in plain English, get tables and charts",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
