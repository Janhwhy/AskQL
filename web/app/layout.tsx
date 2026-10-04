import type { Metadata } from "next";
import { DM_Sans, Geist, Geist_Mono, IBM_Plex_Sans, Inter, Manrope, Space_Grotesk, Work_Sans } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Text-box font menu (dashboard canvas). Sans families only, by design.
// preload:false -- each one's @font-face is still declared, but the file is
// only fetched when a text box actually uses it, so the menu costs nothing
// on pages that don't.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], preload: false });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], preload: false });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], preload: false });
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], preload: false });
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"], preload: false });

export const metadata: Metadata = {
  title: "AskQL — answers in plain English",
  description: "Ask a business question, get a chart, an insight, and the SQL behind it.",
};

const fontVars = [geistSans, geistMono, inter, dmSans, manrope, spaceGrotesk, plexSans, workSans]
  .map((f) => f.variable)
  .join(" ");

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fontVars} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
