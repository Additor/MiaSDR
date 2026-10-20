"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Adds the `dark` class to <html> from the saved choice or the system setting. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
