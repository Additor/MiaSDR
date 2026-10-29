"use client";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, minHeight: "100svh", display: "grid", placeItems: "center" }}>
        <main style={{ maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
          <p style={{ color: "oklch(0.52 0 0)", fontSize: 14 }}>MiaSDR failed to load{error.digest ? ` (reference ${error.digest})` : ""}. Try again.</p>
          <button type="button" onClick={retry} style={{ padding: "6px 12px", fontSize: 14 }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
