import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dub Together",
  description: "A multiplayer dubbing studio for Choicer Voicer Dub Packs.",
  applicationName: "Dub Together",
  metadataBase: new URL("https://dub-together.pegodego700.chatgpt.site"),
  openGraph: {
    title: "Dub Together",
    description: "Record every character together — right in your browser.",
    type: "website",
  },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="nl"><body>{children}</body></html>;
}
