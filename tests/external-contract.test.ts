import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type Account,
  type CheckoutLink,
  CozeniError,
  type CreateProduct,
  createCustomerClient,
  createManagementClient,
  type Entitlement,
  type Product,
  type ProductList,
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
const product = fixture.product satisfies Product;
const input = fixture.create_product satisfies CreateProduct;
const update = {
  price_jpy: fixture.create_product.price_jpy,
} satisfies UpdateProduct;
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
  additionalProperties?: boolean;
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
    if (requestSchema)
      expect(matches(requestSchema, JSON.parse(String(init?.body)))).toBe(true);
    else expect(init?.body).toBeUndefined();
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
      ReturnType<Management["checkoutLinks"]["get"]>
    >().toEqualTypeOf<Promise<CheckoutLink>>();
    expectTypeOf<
      ReturnType<ReturnType<typeof createCustomerClient>["checkEntitlement"]>
    >().toEqualTypeOf<Promise<Entitlement>>();
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
      // 公開APIはcamelCase。正本fixtureのenter_urlはproduct.id（"prd_example"）とは
      // 異なる商品IDの例（"prd_0123456789abcdef..."）で書かれているため、SDKの
      // product_id一致検証によりこのproductIdでの問い合わせでは採用されない。
      // 一致・不一致の採用可否そのものは専用テストで検証する。
      const { enter_url: _enterUrl, ...expected } = body as Record<
        string,
        unknown
      >;
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
    // 正本fixtureのenter_urlはproduct.idと異なる商品IDの例のため採用されない
    // （上のテストと同じ理由）。ここではCookie無し呼び出し自体を検証する。
    expect(result).toEqual({ entitled: false, reason: "no_session" });
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
