import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Rewind",
    template: "%s · Rewind",
  },
  description: "Your private archive of saved creator videos.",
  manifest: "/manifest.webmanifest",
  applicationName: "Rewind",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Rewind",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/rewind-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/rewind-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080a09",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
