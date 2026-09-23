import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // next本体がpackage.jsonにexportsを持たないため、SDKのnode_modules経由の
    // "next/headers" 等はNode本来のESM解決では失敗する。Vite側の緩い解決に
    // 任せるため、SDKパッケージを外部化せずインライン処理する。
    server: { deps: { inline: ["@nulogic/cozeni-sdk"] } },
  },
});
