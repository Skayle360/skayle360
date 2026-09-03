import type { ReactNode } from "react";

export const metadata = {
  title: "SCALE UP assistant",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Grammarly and similar extensions write their own attributes onto <body>
    // before React hydrates (data-new-gr-c-s-check-loaded, data-gr-ext-installed),
    // which reads as a hydration mismatch and buries real ones in the noise.
    // This suppresses the warning for <body>'s own attributes only -- mismatches
    // anywhere inside the tree still report normally.
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
