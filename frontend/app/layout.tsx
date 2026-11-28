import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@/components/analytics/analytics";
import { CookieBanner } from "@/components/consent/cookie-consent";
import { ToastProvider } from "@/components/toast/toast";
import { PRODUCT_DESCRIPTION, PRODUCT_NAME, SITE_URL, THEME_COLOR } from "@/lib/brand";
import { OG_IMAGE } from "@/lib/seo";
import "./globals.css";

// Fonts are VENDORED (app/fonts): latin-subset woff2 of SIL OFL families, each with its OFL.txt,
// so the build fetches nothing from Google. Same CSS variables and weights as before.
const display = localFont({
  src: [
    { path: "./fonts/montserrat/montserrat-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/montserrat/montserrat-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/montserrat/montserrat-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  variable: "--font-display",
});

const sans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-sans",
});

const mono = localFont({
  src: [{ path: "./fonts/ibm-plex-mono/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" }],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: PRODUCT_NAME,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: PRODUCT_DESCRIPTION,
  applicationName: PRODUCT_NAME,
  icons: {
    icon: ["/favicon.ico", { url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    locale: "en_KE",
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  // Lets pages pad for notches and home indicators with env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-KE" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="bg-background text-foreground font-sans antialiased">
        {/* ONE provider for the whole app: a toast raised in the shell survives the move to
            /login (sign-out), and /login raises its own (session expiry). */}
        <ToastProvider>{children}</ToastProvider>
        <Analytics />
        <CookieBanner />
      </body>
    </html>
  );
}
