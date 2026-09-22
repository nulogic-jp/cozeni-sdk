import type { ReactNode } from "react";
export const metadata = { title: "Cozeni 購入者限定ページの導入例" };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          maxWidth: 720,
          margin: "64px auto",
          padding: 24,
          fontFamily: "sans-serif",
          lineHeight: 1.8,
        }}
      >
        {children}
      </body>
    </html>
  );
}
