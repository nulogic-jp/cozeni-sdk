import { defineConfig } from "vitest/config";

// ルートの検査はSDK本体のテストだけを対象にする。Next.js導入例は配布物経由で
// scripts/verify-example.mjs が検証するため、ここから拾わない。
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
