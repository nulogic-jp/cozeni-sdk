import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createWebHandler } from "./web-handler.mjs";

function incomingHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) result.append(name, item);
    }
  }
  return result;
}

/** Node.js HTTPサーバーをWeb標準ハンドラーへ接続する。 */
export function createNodeServer(config, dependencies) {
  const handle = createWebHandler(config, dependencies);
  const trustedOrigin = new URL(config.siteOrigin).origin;

  return createServer(async (incoming, outgoing) => {
    try {
      const target = incoming.url ?? "/";
      // absolute-formやスキーム相対URLを拒否し、Hostヘッダーを信頼originに使わない。
      if (!target.startsWith("/") || target.startsWith("//")) {
        outgoing.writeHead(400).end("Bad Request");
        return;
      }
      const request = new Request(new URL(target, trustedOrigin), {
        method: incoming.method,
        headers: incomingHeaders(incoming.headers),
      });
      const response = await handle(request);
      const headers = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      // 例外や要求内容を返さず、設定不備・通信失敗はいずれも閉じて失敗する。
      outgoing.writeHead(500, {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      outgoing.end("Internal Server Error");
    }
  });
}

function environmentConfig() {
  return {
    apiOrigin: process.env.COZENI_API_ORIGIN,
    siteOrigin: process.env.COZENI_SITE_ORIGIN,
    productId: process.env.COZENI_PRODUCT_ID,
    checkoutUrl: process.env.COZENI_CHECKOUT_URL,
    protectedContent: process.env.COZENI_PROTECTED_CONTENT,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? "3100");
  const server = createNodeServer(environmentConfig());
  server.listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port} で起動しました。`);
  });
}
