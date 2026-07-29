import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ProjectSync } from "@/lib/project-sync";
import { getCurrentUser } from "@/lib/auth/session";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vastos — AI Interior Design",
  description: "Turn a floor plan into photorealistic AI interior renders and walkthrough videos.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Fetched once here (a Server Component) so the client-side AppShell/Sidebar
  // can gate the Console nav link on role without needing their own auth
  // check — getCurrentUser() degrades to null when logged out/unconfigured,
  // same "app works without Supabase" contract as the rest of this codebase.
  const user = await getCurrentUser();

  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <ProjectSync userId={user?.id ?? null} />
        <AppShell role={user?.role ?? null}>{children}</AppShell>
      </body>
    </html>
  );
}
