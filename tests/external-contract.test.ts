import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type AccessType,
  type Account,
  type CheckoutLink,
  CozeniError,
  type CreateProduct,
  type CustomerState,
  createCustomerClient,
  createManagementClient,
  type Entitlement,
  type FeatureFlagMetadata,
  type Product,
  type ProductImage,
  type ProductList,
  type Scope,
  type UpdateProduct,
} from "../src/index.js";
import { fixture } from "./fixtures/external-api-v1.literal.js";

// 正式JSONの値を型検査する。literal版とJSONの内容一致も別テストで保証する。
const account = {
  ...fixture.account,
  scopes: [...fixture.account.scopes],
  sales: {
    ...fixture.account.sales,
    blockers: fixture.account.sales.blockers.map((blocker) => ({
      ...blocker,
    })),
    warnings: [...fixture.account.sales.warnings],
  },
} satisfies Account;
// as constのimagesはreadonlyタプルなので、公開型（可変配列）へ複製して型検査する。
const product = {
  ...fixture.product,
  images: fixture.product.images.map((image) => ({ ...image })),
} satisfies Product;
const input = fixture.create_product satisfies CreateProduct;
const update = {
  price_jpy: fixture.create_product.price_jpy,
} satisfies UpdateProduct;
// 画像アップロードの入力。形式は中身で判定されるため、PNGシグネチャの数バイトで足りる。
const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
  type: "image/png",
});
const link = fixture.checkout_link satisfies CheckoutLink;
const list = { items: [product], next_cursor: null } satisfies ProductList;
const entitlements = fixture.entitlements satisfies readonly {
  status: number;
  body: Entitlement;
}[];
const official = JSON.parse(
  readFileSync(
    new URL("./fixtures/external-api-v1.json", import.meta.url),
    "utf8",
  ),
);
interface Schema {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  oneOf?: Schema[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  nullable?: boolean;
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
}
interface Operation {
  operationId: string;
  security?: Record<string, unknown>[];
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema: Schema;
  }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}
const specification = JSON.parse(
  readFileSync(
    new URL("./fixtures/openapi-external.json", import.meta.url),
    "utf8",
  ),
) as {
  servers: { url: string }[];
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<
      string,
      { type: string; scheme?: string; in?: string; name?: string }
    >;
  };
  paths: Record<string, Record<string, Operation>>;
};
const operations = Object.entries(specification.paths).flatMap(
  ([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      path,
      method: method.toUpperCase(),
      ...operation,
    })),
);
const apiOrigin = "https://api.contract.example";
const apiKey = "contract-key-not-a-secret";
const customerCookie = "cozeni_customer=fixture.token.value";

// この契約で使うJSON Schema項目を検証する。SDKの判定実装には依存しない。
function matches(schema: Schema, value: unknown): boolean {
  if (schema.$ref) {
    const target =
      specification.components.schemas[schema.$ref.split("/").at(-1) ?? ""];
    if (!target) throw new Error("契約に参照先schemaがありません。");
    return matches(target, value);
  }
  if (value === null && schema.nullable) return true;
  if (schema.allOf && !schema.allOf.every((part) => matches(part, value)))
    return false;
  if (schema.oneOf)
    return (
      schema.oneOf.filter((candidate) => matches(candidate, value)).length === 1
    );
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((key) => !(key in object))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(object).some((key) => !schema.properties?.[key])
    )
      return false;
    // スキーマ形式のadditionalPropertiesは、properties以外のキーの値に適用する。
    const extra = schema.additionalProperties;
    if (
      extra &&
      typeof extra === "object" &&
      Object.entries(object).some(
        ([key, item]) => !schema.properties?.[key] && !matches(extra, item),
      )
    )
      return false;
    return Object.entries(schema.properties ?? {}).every(
      ([key, property]) => !(key in object) || matches(property, object[key]),
    );
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      value.every((item) => !schema.items || matches(schema.items, item))
    );
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return false;
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value)))
      return false;
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        return false;
      }
    }
  }
  if (
    schema.type === "integer" &&
    (typeof value !== "number" || !Number.isInteger(value))
  )
    return false;
  if (schema.type === "number" && typeof value !== "number") return false;
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  return true;
}
function operationById(id: string) {
  const operation = operations.find((item) => item.operationId === id);
  if (!operation) throw new Error("外部API契約に対応操作がありません。");
  return operation;
}
function contractFetch(id: string, status: number, responseBody: unknown) {
  const operation = operationById(id);
  const responseSchema =
    operation.responses[String(status)]?.content?.["application/json"]?.schema;
  expect(responseSchema).toBeDefined();
  if (!responseSchema || !matches(responseSchema, responseBody))
    throw new Error("応答fixtureが外部API契約に合いません。");
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url).split("?")[0]).toBe(
      apiOrigin +
        specification.servers[0]?.url +
        operation.path.replace("{product_id}", product.id),
    );
    expect(init?.method).toBe(operation.method);
    const headers = new Headers(init?.headers);
    // 契約のsecurityが空({})の代替を含む場合、認証は任意（Cookie無しでも呼べる）。
    const authOptional = operation.security?.some(
      (scheme) => Object.keys(scheme).length === 0,
    );
    if (operation.security?.some((scheme) => "CreatorApiKey" in scheme)) {
      expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(headers.has("Cookie")).toBe(false);
    } else if (
      operation.security?.some((scheme) => "CustomerCookie" in scheme)
    ) {
      if (!authOptional) expect(headers.get("Cookie")).toBe(customerCookie);
      expect(headers.has("Authorization")).toBe(false);
    } else {
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
    }
    const requestSchema =
      operation.requestBody?.content["application/json"]?.schema;
    const multipartSchema =
      operation.requestBody?.content["multipart/form-data"]?.schema;
    if (requestSchema)
      expect(matches(requestSchema, JSON.parse(String(init?.body)))).toBe(true);
    else if (multipartSchema) {
      // multipartは契約のrequired欄がBlobで入っていること。Content-Typeを手で
      // 設定するとfetchが付けるboundaryが壊れるため、ヘッダーに無いことも確かめる。
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      const target = multipartSchema.$ref
        ? specification.components.schemas[
            multipartSchema.$ref.split("/").at(-1) ?? ""
          ]
        : multipartSchema;
      expect(target?.required?.length).toBeGreaterThan(0);
      for (const field of target?.required ?? [])
        expect((body as FormData).get(field)).toBeInstanceOf(Blob);
      expect(headers.has("Content-Type")).toBe(false);
    } else expect(init?.body).toBeUndefined();
    for (const parameter of operation.parameters ?? []) {
      if (parameter.in === "header" && parameter.required) {
        const value = headers.get(parameter.name);
        expect(value).not.toBeNull();
        expect(matches(parameter.schema, value)).toBe(true);
      }
    }
    return Response.json(responseBody, { status });
  });
}
type Management = ReturnType<typeof createManagementClient>;
const managementCases = [
  {
    id: "externalGetAccount",
    status: 200,
    response: account,
    call: (client: Management) => client.account.get(),
  },
  {
    id: "externalListProducts",
    status: 200,
    response: list,
    call: (client: Management) =>
      client.products.list({ limit: 20, cursor: "opaque+/cursor=" }),
  },
  {
    id: "externalGetProduct",
    status: 200,
    response: product,
    call: (client: Management) => client.products.get(product.id),
  },
  {
    id: "externalCreateProduct",
    status: 201,
    response: product,
    call: (client: Management) =>
      client.products.create(input, { idempotencyKey: "saved-before-post" }),
  },
  {
    id: "externalUpdateProduct",
    status: 200,
    response: product,
    call: (client: Management) => client.products.update(product.id, update),
  },
  {
    id: "externalPutProductImage",
    status: 200,
    response: product,
    call: (client: Management) => client.products.putImage(product.id, image),
  },
  {
    id: "externalDeleteProductImage",
    status: 200,
    response: product,
    call: (client: Management) => client.products.deleteImage(product.id),
  },
  {
    id: "externalGetCheckoutLink",
    status: 200,
    response: link,
    call: (client: Management) => client.checkoutLinks.get(product.id),
  },
  {
    id: "externalEnsureCheckoutLink",
    status: 200,
    response: link,
    call: (client: Management) => client.checkoutLinks.ensure(product.id),
  },
  {
    id: "externalCreateCheckoutSession",
    status: 201,
    response: {
      checkout_id: fixture.checkout_session.checkout_id,
      url: fixture.checkout_session.url,
      expires_at: fixture.checkout_session.expires_at,
    },
    // SDKはcamelCaseで返すので、契約の応答（snake_case）への写像を戻して比べる。
    call: async (client: Management) => {
      const result = await client.createCheckout({
        productId: fixture.checkout_session_input.product_id,
        email: fixture.checkout_session_input.email,
      });
      return {
        checkout_id: result.checkoutId,
        url: result.url,
        expires_at: result.expiresAt,
      };
    },
  },
  {
    id: "externalGetCustomerState",
    status: 200,
    response: {
      customer_id: fixture.customer_state.customer_id,
      feature_flags: fixture.customer_state.feature_flags.map((flag) => ({
        ...flag,
        metadata: { ...flag.metadata },
      })),
    },
    call: async (client: Management) => {
      const result = await client.getCustomerState({
        email: fixture.customer_state_input.email,
      });
      return {
        customer_id: result.customerId,
        feature_flags: result.featureFlags.map((flag) => ({
          product_id: flag.productId,
          benefit_id: flag.benefitId,
          granted_at: flag.grantedAt,
          metadata: flag.metadata,
        })),
      };
    },
  },
];
// 契約にあるが、このファイルでは検証しない操作。契約に操作が増えたら、
// ここに理由付きで足すか、上のケースで検証するまで一覧の一致検査が落ちる。
const uncoveredOperations = [
  // CLIのログイン・ログアウト・テスト購入。CLIのテストが独自のモックで検証している。
  "externalCreateCliDeviceCode",
  "externalCreateCliToken",
  "externalCliLogout",
  "externalStartTestPurchase",
  "externalRefundTestPurchase",
];
describe("正式外部v1契約とSDK", () => {
  it("JSONと型検査用fixtureが一致し、公開型が導入者に返る", () => {
    expect(fixture).toEqual(official);
    expectTypeOf<ReturnType<Management["account"]["get"]>>().toEqualTypeOf<
      Promise<Account>
    >();
    expectTypeOf<ReturnType<Management["products"]["list"]>>().toEqualTypeOf<
      Promise<ProductList>
    >();
    expectTypeOf<ReturnType<Management["products"]["get"]>>().toEqualTypeOf<
      Promise<Product>
    >();
    expectTypeOf<
      ReturnType<Management["products"]["putImage"]>
    >().toEqualTypeOf<Promise<Product>>();
    expectTypeOf<
      ReturnType<Management["products"]["deleteImage"]>
    >().toEqualTypeOf<Promise<Product>>();
    expectTypeOf<
      ReturnType<Management["checkoutLinks"]["get"]>
    >().toEqualTypeOf<Promise<CheckoutLink>>();
    expectTypeOf<
      ReturnType<ReturnType<typeof createCustomerClient>["checkEntitlement"]>
    >().toEqualTypeOf<Promise<Entitlement>>();
    expectTypeOf<
      ReturnType<ReturnType<typeof createCustomerClient>["createPortalLink"]>
    >().toEqualTypeOf<Promise<{ url: string }>>();
    expect(
      specification.components.securitySchemes.CreatorApiKey,
    ).toMatchObject({ type: "http", scheme: "bearer" });
    expect(
      specification.components.securitySchemes.CustomerCookie,
    ).toMatchObject({ type: "apiKey", in: "cookie", name: "cozeni_customer" });
    expect(operations.map((item) => item.operationId).sort()).toEqual(
      [
        ...managementCases.map((item) => item.id),
        "externalExchangeHandoff",
        "externalCheckEntitlements",
        "externalCreatePortalLink",
        ...uncoveredOperations,
      ].sort(),
    );
  });
  it.each(managementCases)(
    "$id の成功経路・認証・入出力が正本に一致する",
    async (testCase) => {
      const fetch = contractFetch(
        testCase.id,
        testCase.status,
        testCase.response,
      );
      const client = createManagementClient({ apiOrigin, apiKey, fetch });
      expect(await testCase.call(client)).toEqual(testCase.response);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (testCase.id === "externalListProducts") {
        const url = new URL(String(fetch.mock.calls[0]?.[0]));
        expect(url.searchParams.get("cursor")).toBe("opaque+/cursor=");
        expect(url.searchParams.get("limit")).toBe("20");
      }
    },
  );
  it.each(managementCases)(
    "$id は正式のscope拒否fixtureを構造化エラーで返す",
    async (testCase) => {
      const fetch = contractFetch(testCase.id, 403, fixture.error);
      await expect(
        testCase.call(createManagementClient({ apiOrigin, apiKey, fetch })),
      ).rejects.toMatchObject({
        status: 403,
        code: fixture.error.error.code,
        requestId: fixture.error.error.request_id,
      });
    },
  );
  it.each([
    { status: 413, code: "image_too_large" },
    { status: 415, code: "unsupported_image_type" },
  ])(
    "画像のHTTP $status / $code は構造化エラーで返す（invalid_responseに潰さない）",
    async ({ status, code }) => {
      const body = {
        error: { ...fixture.error.error, code },
      };
      const fetch = contractFetch("externalPutProductImage", status, body);
      await expect(
        createManagementClient({ apiOrigin, apiKey, fetch }).products.putImage(
          product.id,
          image,
        ),
      ).rejects.toMatchObject({
        status,
        code,
        requestId: fixture.error.error.request_id,
      });
    },
  );
  it("画像の削除は画像が無くても200の商品を返し、本文を送らない", async () => {
    const withoutImage = { ...product, images: [] };
    const fetch = contractFetch(
      "externalDeleteProductImage",
      200,
      withoutImage,
    );
    expect(
      await createManagementClient({
        apiOrigin,
        apiKey,
        fetch,
      }).products.deleteImage(product.id),
    ).toEqual(withoutImage);
  });
  it("商品の説明（description）は任意・nullableで送れる", () => {
    expectTypeOf<CreateProduct["description"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<UpdateProduct["description"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<Product["description"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Product["images"]>().toEqualTypeOf<ProductImage[]>();
  });
  it("標準リンクを新規作成した201も契約通り処理する", async () => {
    const fetch = contractFetch("externalEnsureCheckoutLink", 201, link);
    expect(
      await createManagementClient({
        apiOrigin,
        apiKey,
        fetch,
      }).checkoutLinks.ensure(product.id),
    ).toEqual(link);
  });
  it("実fixtureの単回コードを交換し、購入者tokenだけを返す", async () => {
    const fetch = contractFetch(
      "externalExchangeHandoff",
      200,
      fixture.handoff_output,
    );
    expect(
      await createCustomerClient({ apiOrigin, fetch }).exchangeHandoff(
        fixture.handoff_input.code,
      ),
    ).toEqual(fixture.handoff_output);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(
      fixture.handoff_input,
    );
  });
  it.each(entitlements)(
    "購入者HTTP $status / $body は正本と同じ許可・拒否を返す",
    async ({ status, body }) => {
      const fetch = contractFetch("externalCheckEntitlements", status, body);
      // 公開APIはcamelCase。正本fixtureのenter_urlはproduct.idと一致する商品IDで
      // 書かれているため、product_id一致検証を経てenterUrlとして採用される。
      const { enter_url, ...rest } = body as Record<string, unknown>;
      const expected = enter_url ? { ...rest, enterUrl: enter_url } : rest;
      expect(
        await createCustomerClient({ apiOrigin, fetch }).checkEntitlement({
          productId: product.id,
          cookieHeader: `unrelated=discard; ${customerCookie}`,
        }),
      ).toEqual(expected);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(
        fixture.entitlement_input,
      );
    },
  );
  it("Cookie無しでも正本の権利確認APIを呼び、Cookieヘッダーを送らない", async () => {
    const found = entitlements.find(
      (item) => item.status === 401 && "enter_url" in item.body,
    );
    if (!found)
      throw new Error("no_session + enter_urlのfixtureがありません。");
    const fetch = contractFetch(
      "externalCheckEntitlements",
      found.status,
      found.body,
    );
    const result = await createCustomerClient({
      apiOrigin,
      fetch,
    }).checkEntitlement({
      productId: product.id,
    });
    // 正本fixtureのenter_urlはproduct.idと一致するため採用される。
    expect(result).toEqual({
      entitled: false,
      reason: "no_session",
      enterUrl: (found.body as { enter_url: string }).enter_url,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Cookie")).toBe(
      false,
    );
  });
  it("enter_urlのproduct_idが問い合わせたproductIdと一致するときだけ採用する", async () => {
    const matching = `https://checkout.example/enter?product_id=${product.id}`;
    const mismatched =
      "https://checkout.example/enter?product_id=prd_other0000000000000000000000000000";
    for (const [enterUrlValue, expectAdopted] of [
      [matching, true],
      [mismatched, false],
    ] as const) {
      const body = {
        entitled: false,
        reason: "no_grant",
        enter_url: enterUrlValue,
      };
      const fetch = contractFetch("externalCheckEntitlements", 200, body);
      const result = await createCustomerClient({
        apiOrigin,
        fetch,
      }).checkEntitlement({
        productId: product.id,
        cookieHeader: customerCookie,
      });
      expect(result).toEqual(
        expectAdopted
          ? { entitled: false, reason: "no_grant", enterUrl: matching }
          : { entitled: false, reason: "no_grant" },
      );
    }
  });
  it("ポータルのリンク発行は購入者Cookieだけで認証し、本文を送らず200/401/503を返す", () => {
    const operation = operationById("externalCreatePortalLink");
    expect(operation.method).toBe("POST");
    expect(operation.path).toBe("/customer/portal-link");
    expect(operation.security).toEqual([{ CustomerCookie: [] }]);
    expect(operation.requestBody).toBeUndefined();
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "401",
      "503",
    ]);
    // 下のエラーのケースが正本の401 no_session・503 unavailableを網羅していること。
    expect(
      fixture.portal_link_errors.map(({ status, body }) => [
        status,
        body.error.code,
      ]),
    ).toEqual([
      [401, "no_session"],
      [503, "unavailable"],
    ]);
  });
  it("実fixtureのポータルURLを構造検証に通して返す", async () => {
    const fetch = contractFetch(
      "externalCreatePortalLink",
      200,
      fixture.portal_link,
    );
    expect(
      await createCustomerClient({ apiOrigin, fetch }).createPortalLink({
        cookieHeader: `unrelated=discard; ${customerCookie}`,
        creatorId: fixture.account.creator_id,
      }),
    ).toEqual(fixture.portal_link);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([...fixture.portal_link_errors])(
    "ポータルのリンク発行HTTP $status / $body.error.code は構造化エラーで返す",
    async ({ status, body }) => {
      const fetch = contractFetch("externalCreatePortalLink", status, body);
      const result = createCustomerClient({
        apiOrigin,
        fetch,
      }).createPortalLink({ cookieHeader: customerCookie });
      await expect(result).rejects.toBeInstanceOf(CozeniError);
      await expect(result).rejects.toMatchObject({
        status,
        code: body.error.code,
        requestId: body.error.request_id,
      });
    },
  );
  it.each([400, 503])(
    "コード交換HTTP %sではAPIエラーの契約を維持する",
    async (status) => {
      const fetch = contractFetch(
        "externalExchangeHandoff",
        status,
        fixture.error,
      );
      await expect(
        createCustomerClient({ apiOrigin, fetch }).exchangeHandoff(
          fixture.handoff_input.code,
        ),
      ).rejects.toBeInstanceOf(CozeniError);
    },
  );
});

describe("機能フラグの外部契約とSDK", () => {
  it("機能フラグ・ファイルの商品（access_url: null）が型と契約に合う", () => {
    // as constのimagesはreadonlyタプルなので、公開型（可変配列）へ複製して型検査する。
    const featureProduct = {
      ...fixture.feature_product,
      images: [...fixture.feature_product.images],
    } satisfies Product;
    expect(featureProduct.access_type).toBe("feature");
    expect(featureProduct.access_url).toBeNull();
    expectTypeOf<Product["access_url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Product["access_type"]>().toEqualTypeOf<AccessType>();
    expectTypeOf<AccessType>().toEqualTypeOf<"page" | "feature" | "file">();
    expectTypeOf<Product["metadata"]>().toEqualTypeOf<FeatureFlagMetadata>();
  });
  it("作成の型は page 形と feature 形だけを受け付ける", () => {
    const page = fixture.create_product satisfies CreateProduct;
    const feature = fixture.create_feature_product satisfies CreateProduct;
    // @ts-expect-error feature 形に access_url は書けない
    const mixed: CreateProduct = {
      ...feature,
      access_url: "https://example.com",
    };
    // @ts-expect-error page 形に metadata は書けない
    const pageWithMetadata: CreateProduct = { ...page, metadata: { a: 1 } };
    const file: CreateProduct = {
      name: "資料",
      price_jpy: 100,
      // @ts-expect-error file は作成の入力に使えない
      access_type: "file",
    };
    expect([page, feature, mixed, pageWithMetadata, file]).toHaveLength(5);
  });
  it("更新の型は access_type を送れず、metadata・description を受け付ける", () => {
    const body = {
      metadata: { plan: "pro" },
      description: null,
    } satisfies UpdateProduct;
    // @ts-expect-error access_type は作成後に変えられない
    const typeChange: UpdateProduct = { access_type: "feature" };
    expect([body, typeChange]).toHaveLength(2);
  });
  it("設定値の契約は値の型を縛り、null・空文字・入れ子を拒否する", () => {
    const metadata: Schema = {
      $ref: "#/components/schemas/ExternalFeatureFlagMetadata",
    };
    const updateMetadata =
      specification.components.schemas.ExternalUpdateProduct?.properties
        ?.metadata;
    expect(updateMetadata?.allOf).toBeDefined();
    for (const schema of [metadata, updateMetadata as Schema]) {
      expect(matches(schema, { plan: "pro", n: 100, beta: true })).toBe(true);
      expect(matches(schema, {})).toBe(true);
      expect(matches(schema, { a: null })).toBe(false);
      expect(matches(schema, { a: "" })).toBe(false);
      expect(matches(schema, { a: { nested: true } })).toBe(false);
    }
  });
  it("スコープに customers:read・checkouts:write がある", () => {
    const scopes = [
      "customers:read",
      "checkouts:write",
    ] as const satisfies readonly Scope[];
    expect(scopes).toHaveLength(2);
  });
  it("購入者の状態の型が契約の例（camelCase）と合う", () => {
    const state = {
      customerId: fixture.customer_state.customer_id,
      featureFlags: fixture.customer_state.feature_flags.map((flag) => ({
        productId: flag.product_id,
        benefitId: flag.benefit_id,
        grantedAt: flag.granted_at,
        metadata: { ...flag.metadata },
      })),
    } satisfies CustomerState;
    expect(state.featureFlags).toHaveLength(1);
    expectTypeOf<CustomerState["customerId"]>().toEqualTypeOf<string | null>();
  });
});
