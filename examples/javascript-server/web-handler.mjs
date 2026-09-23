import {
  CozeniError,
  createCustomerClient,
  customerCookie,
  enterRedirectResponse,
  trustedSiteUrl,
} from "@nulogic/cozeni-sdk";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`サーバー設定 ${name} が必要です。`);
  }
  return value;
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function denialStatus(reason) {
  if (reason === "unavailable") return 503;
  if (reason === "no_session") return 401;
  return 403;
}

function deniedResponse(entitlement, asJson = false) {
  const { reason } = entitlement;
  const status = denialStatus(reason);
  if (asJson) {
    // Route相当のJSON応答はリダイレクトせず、enter_urlを本文へ含めるだけにする。
    const body =
      reason !== "unavailable" && entitlement.enterUrl
        ? { error: reason, enter_url: entitlement.enterUrl }
        : { error: reason };
    return Response.json(body, { status, headers: privateHeaders });
  }
  const message =
    reason === "unavailable"
      ? "権限を確認できません。時間をおいて再試行してください。"
      : reason === "revoked"
        ? "この商品の利用権限は無効です。"
        : reason === "no_grant"
          ? "この商品の購入権限がありません。"
          : "購入時のメールアドレスで再入場してください。";
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>アクセス拒否</title><main><h1>コンテンツを表示できません</h1><p>${message}</p></main>`,
    {
      status,
      headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

/**
 * Web標準Request/Responseを扱うフレームワーク向けのハンドラーを作る。
 * APIキーは不要で、購入者CookieだけをCozeniへ転送する。
 */
export function createWebHandler(config, dependencies = {}) {
  const apiOrigin = required(config.apiOrigin, "COZENI_API_ORIGIN");
  const siteOrigin = required(config.siteOrigin, "COZENI_SITE_ORIGIN");
  const productId = required(config.productId, "COZENI_PRODUCT_ID");
  const checkoutUrl = (() => {
    const url = new URL(required(config.checkoutUrl, "COZENI_CHECKOUT_URL"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("サーバー設定 COZENI_CHECKOUT_URL が不正です。");
    }
    return url.href;
  })();
  const protectedContent = required(
    config.protectedContent,
    "COZENI_PROTECTED_CONTENT",
  );
  const membersUrl = trustedSiteUrl(siteOrigin, "/members");
  const handoffUrl = trustedSiteUrl(siteOrigin, "/cozeni/handoff");
  const customer =
    dependencies.customerClient ??
    createCustomerClient({ apiOrigin, timeoutMs: config.timeoutMs ?? 3000 });
  const reportError = dependencies.reportError ?? ((operation) => {
    // コード、Cookie、例外本文、設定値はログへ含めない。
    console.error("[cozeni] サーバー処理エラー", { operation });
  });

  async function entitlement(request) {
    try {
      return await customer.checkEntitlement({
        productId,
        cookieHeader: request.headers.get("Cookie") ?? undefined,
      });
    } catch {
      return { entitled: false, reason: "unavailable" };
    }
  }

  function home() {
    return new Response(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><title>商品</title><main><h1>商品</h1><a href="${escapeHtml(checkoutUrl)}">購入する</a></main>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "strict-origin",
        },
      },
    );
  }

  async function members(request, requestUrl) {
    const codes = requestUrl.searchParams.getAll("cozeni_code");
    if (codes.length > 0) {
      const valid = codes.length === 1 && Boolean(codes[0]);
      const target = new URL(valid ? handoffUrl : membersUrl);
      if (valid) {
        target.searchParams.set("cozeni_code", codes[0]);
      } else {
        target.searchParams.set("cozeni_error", "invalid_code");
      }
      return new Response(null, {
        status: 303,
        headers: { ...privateHeaders, Location: target.href },
      });
    }

    // ハンドオフのコード交換直後（cozeni_handoff付き＝成功直後、または
    // cozeni_error付き＝交換失敗）は、enter_urlがあっても再リダイレクトせず、
    // 拒否画面に留める（無限リダイレクトの回避）。
    const haltRedirect =
      requestUrl.searchParams.has("cozeni_error") ||
      requestUrl.searchParams.has("cozeni_handoff");
    const result = await entitlement(request);
    if (!result.entitled) {
      const redirectResponse = haltRedirect
        ? undefined
        : enterRedirectResponse(result, productId);
      return redirectResponse ?? deniedResponse(result);
    }
    // ここに到達したら権利がある。ハンドオフ成功直後の印が付いていれば、
    // 印を外したクリーンなURLへ正規化する（アドレスバーに残さない）。
    if (requestUrl.searchParams.has("cozeni_handoff")) {
      return new Response(null, {
        status: 303,
        headers: { ...privateHeaders, Location: membersUrl.href },
      });
    }
    return new Response(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><title>購入者限定</title><main><h1>購入者限定ページ</h1><p>${escapeHtml(protectedContent)}</p></main>`,
      {
        headers: {
          ...privateHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  async function protectedApi(request) {
    const result = await entitlement(request);
    // JSON APIはリダイレクトせず、enter_urlを本文へ含めるだけにする。
    if (!result.entitled) return deniedResponse(result, true);
    return Response.json(
      { content: protectedContent },
      { headers: privateHeaders },
    );
  }

  async function handoff(requestUrl) {
    const headers = new Headers(privateHeaders);
    const codes = requestUrl.searchParams.getAll("cozeni_code");
    try {
      if (codes.length !== 1 || !codes[0]) {
        throw new CozeniError("invalid_code", 400);
      }
      const { token } = await customer.exchangeHandoff(codes[0]);
      headers.set("Set-Cookie", customerCookie(token, membersUrl.origin));
      const target = new URL(membersUrl);
      // ハンドオフ成功直後を示す秘密を含まない印。members()はこれか
      // cozeni_errorがあれば再リダイレクトを止める（無限リダイレクトの回避）。
      target.searchParams.set("cozeni_handoff", "1");
      headers.set("Location", target.href);
    } catch (error) {
      const invalid = error instanceof CozeniError && error.code === "invalid_code";
      if (!invalid) reportError("購入者コード交換");
      const target = new URL(membersUrl);
      target.searchParams.set(
        "cozeni_error",
        invalid ? "invalid_code" : "unavailable",
      );
      headers.set("Location", target.href);
    }
    // 単回コードは必ずURLから除去し、交換失敗時も既存Cookieは消さない。
    return new Response(null, { status: 303, headers });
  }

  return async function handle(request) {
    if (!(request instanceof Request)) {
      throw new TypeError("Web標準Requestが必要です。");
    }
    const requestUrl = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...privateHeaders, Allow: "GET" },
      });
    }
    if (requestUrl.pathname === "/") {
      return home();
    }
    if (requestUrl.pathname === "/members") {
      return members(request, requestUrl);
    }
    if (requestUrl.pathname === "/api/protected") {
      return protectedApi(request);
    }
    if (requestUrl.pathname === "/cozeni/handoff") {
      return handoff(requestUrl);
    }
    return new Response("Not Found", { status: 404 });
  };
}
