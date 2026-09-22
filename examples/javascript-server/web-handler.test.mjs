import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeServer } from "./node-server.mjs";
import { createWebHandler } from "./web-handler.mjs";

const config = {
  apiOrigin: "https://api.example.com",
  siteOrigin: "https://site.example.com",
  productId: "prod_example",
  checkoutUrl: "https://checkout.example.com/buy/example",
  protectedContent: "購入者限定 <本文>",
};
function handler(customerClient, reportError = () => {}) {
  return createWebHandler(config, { customerClient, reportError });
}

test("保存済みcheckout URLを購入ボタンへ設定する", async () => {
  const handle = handler({});
  const response = await handle(new Request("https://site.example.com/"));

  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /href="https:\/\/checkout\.example\.com\/buy\/example"/,
  );
});

test("未購入者へ限定本文を返さない", async () => {
  const handle = handler({
    checkEntitlement: async () => ({ entitled: false, reason: "no_grant" }),
  });
  const response = await handle(new Request("https://site.example.com/members"));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.doesNotMatch(await response.text(), /購入者限定 <本文>/);
});

test("Cookieを使って権利確認し、限定本文をHTMLエスケープする", async () => {
  let input;
  const handle = handler({
    checkEntitlement: async (value) => {
      input = value;
      return { entitled: true };
    },
  });
  const response = await handle(
    new Request("https://site.example.com/members", {
      headers: { Cookie: "cozeni_customer=customer.token" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(input, {
    productId: "prod_example",
    cookieHeader: "cozeni_customer=customer.token",
  });
  assert.match(await response.text(), /購入者限定 &lt;本文&gt;/);
});

test("Cozeni障害時は保護APIを503で拒否する", async () => {
  const handle = handler({
    checkEntitlement: async () => {
      throw new Error("接続失敗");
    },
  });
  const response = await handle(
    new Request("https://site.example.com/api/protected"),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "unavailable" });
});

test("handoff codeを交換し、HttpOnly Cookie設定後にコードなしURLへ戻す", async () => {
  let code;
  const handle = handler({
    exchangeHandoff: async (value) => {
      code = value;
      return { token: "customer.token" };
    },
  });
  const response = await handle(
    new Request(
      "https://site.example.com/cozeni/handoff?cozeni_code=one-time-code",
    ),
  );

  assert.equal(code, "one-time-code");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "https://site.example.com/members");
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
  assert.doesNotMatch(response.headers.get("Location"), /cozeni_code/);
});

test("空または重複したhandoff codeをURLから除去する", async () => {
  const handle = handler({});
  for (const query of ["cozeni_code=", "cozeni_code=first&cozeni_code=second"]) {
    const response = await handle(
      new Request(`https://site.example.com/members?${query}`),
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("Location"),
      "https://site.example.com/members?cozeni_error=invalid_code",
    );
    assert.doesNotMatch(response.headers.get("Location"), /cozeni_code/);
  }
});

test("Node HTTP接続でもHostヘッダーをredirect先へ利用しない", async () => {
  const server = createNodeServer(config, {
    customerClient: {
      exchangeHandoff: async () => ({ token: "customer.token" }),
    },
    reportError: () => {},
  });
  const nodeHandler = server.listeners("request")[0];
  const completed = new Promise((resolve) => {
    const outgoing = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        return this;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    nodeHandler(
      {
        url: "/cozeni/handoff?cozeni_code=one-time-code",
        method: "GET",
        headers: { host: "evil.example" },
      },
      outgoing,
    );
  });
  const response = await completed;

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "https://site.example.com/members");
});
