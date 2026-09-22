// 外部契約JSONから生成。再生成手順は同ディレクトリのREADME.mdを参照。
export const fixture = {
  account: {
    creator_id: "cre_example",
    api_key_id: "key_example",
    scopes: [
      "products:read",
      "products:write",
      "checkout_links:read",
      "checkout_links:write",
    ],
    environment: "development",
    api_version: "v1",
  },
  create_product: {
    name: "配色ハンドブック",
    price_jpy: 3000,
    access_url: "https://creator.example/members",
  },
  product: {
    id: "prd_example",
    name: "配色ハンドブック",
    price_jpy: 3000,
    currency: "jpy",
    access_url: "https://creator.example/members",
    status: "active",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
  },
  checkout_link: {
    id: "lnk_example",
    product_id: "prd_example",
    url: "https://checkout.example/checkout/example",
    disabled: false,
  },
  error: {
    error: {
      code: "insufficient_scope",
      message: "この操作に必要な権限がありません。",
      request_id: "req_example",
    },
  },
  entitlements: [
    {
      status: 200,
      body: {
        entitled: true,
      },
    },
    {
      status: 200,
      body: {
        entitled: false,
        reason: "no_grant",
      },
    },
    {
      status: 200,
      body: {
        entitled: false,
        reason: "revoked",
      },
    },
    {
      status: 401,
      body: {
        entitled: false,
        reason: "no_session",
      },
    },
    {
      status: 503,
      body: {
        entitled: false,
        reason: "unavailable",
      },
    },
  ],
  handoff_input: {
    code: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  handoff_output: {
    token: "fixture-only-not-a-valid-jwt",
  },
  entitlement_input: {
    product_id: "prd_example",
  },
} as const;
