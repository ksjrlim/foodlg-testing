import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "FoodLG", description: "Support for the drink change you agreed with your dietitian." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Figtree:wght@400;600;700&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
