import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { InstallEventCatcher } from "@/components/pwa/install-prompt";
import { SerwistProvider } from "@/components/pwa/serwist-provider";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { Toaster } from "@/components/ui/sonner";
import { APP_NAME, THEME_COLOR } from "@/lib/brand";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const ZOD_JITLESS = "(globalThis.__zod_globalConfig ??= {}).jitless = true;";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Photocopy machine rental management.",
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        {/* Before any chunk loads: Zod 4 builds object schemas without `new Function` in the
            browser. Its feature probe is otherwise reported as a CSP violation (decision 87).
            Zod reads this global when it loads, so no page pays for Zod unless it uses it. */}
        <script dangerouslySetInnerHTML={{ __html: ZOD_JITLESS }} />
      </head>
      <body className="flex min-h-full flex-col">
        <SerwistProvider>{children}</SerwistProvider>
        <UpdateBanner />
        <InstallEventCatcher />
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
