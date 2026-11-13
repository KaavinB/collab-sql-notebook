import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Collab SQL Notebook",
  description: "A collaborative SQL notebook with an AI collaborator",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
