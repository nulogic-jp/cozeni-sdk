import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProducts, setupProduct } from "./setup.mjs";

const config = {
  creatorId: "cre_test",
  environment: "development",
  apiOrigin: "http://localhost:8787",
  siteOrigin: "http://127.0.0.1:3100",
  product: {
    name: "利用者が確認した教材",
    price_jpy: 3000,
    access_url: "http://127.0.0.1:3100/members",
  },
};
function fixture() {
  const calls = [];
  const product = { ...config.product, id: "prd_test", status: "active" };
  const account = {
    creator_id: config.creatorId,
    environment: config.environment,
    api_version: "v1",
    scopes: [
      "products:read",
      "products:write",
      "checkout_links:read",
      "checkout_links:write",
    ],
  };
  const link = {
    id: "lnk_test",
    product_id: product.id,
    url: "http://localhost:8787/checkout/test",
    disabled: false,
  };
  const client = {
    account: { get: async () => account },
    products: {
      create: async (input, options) => {
        calls.push({ input, options });
        return product;
      },
      get: async () => product,
      list: async () => ({ items: [product], next_cursor: null }),
    },
    checkoutLinks: {
      get: async () => link,
      ensure: async () => {
        throw new Error("不要なリンク発行");
      },
    },
  };
  return { client, calls, product, account, link };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "cozeni-skill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "setup-state.json");
}
test("POST前に確認済み入力とキーを保存し、応答喪失後も同じキーと入力で再送する", async (t) => {
  const statePath = await directory(t);
  const { client, product } = fixture();
  let attempt = 0;
  let first;
  client.products.create = async (input, options) => {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(saved.config.product, input);
    assert.equal(saved.idempotencyKey, options.idempotencyKey);
    if (++attempt === 1) {
      first = saved;
      throw new Error("応答喪失");
    }
    assert.deepEqual(saved, first);
    return product;
  };
  await assert.rejects(
    setupProduct({ config, statePath, client, confirmed: true }),
    /応答喪失/,
  );
  const state = await setupProduct({
    config,
    statePath,
    client,
    confirmed: true,
  });
  assert.equal(attempt, 2);
  assert.equal(state.phase, "complete");
  assert.equal(state.productId, product.id);
  assert.equal(state.idempotencyKey, first.idempotencyKey);
});
test("完了後の再実行と明示選択した既存商品はPOSTしない", async (t) => {
  const statePath = await directory(t);
  const { client, calls } = fixture();
  const existing = { ...config, existingProductId: "prd_test" };
  await setupProduct({ config: existing, statePath, client, confirmed: true });
  await setupProduct({ config: existing, statePath, client, confirmed: true });
  assert.equal(calls.length, 0);
});
test("所有者・環境・APIバージョン・scopeの不一致は書き込み前に停止", async (t) => {
  for (const change of [
    { creator_id: "other" },
    { environment: "production" },
    { api_version: "v2" },
    { scopes: ["products:read"] },
  ]) {
    const statePath = await directory(t);
    const { client, account, calls } = fixture();
    Object.assign(account, change);
    await assert.rejects(
      setupProduct({ config, statePath, client, confirmed: true }),
    );
    assert.equal(calls.length, 0);
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
  }
});
test("未確認と保存済み入力の変更は新しい商品を作らない", async (t) => {
  const statePath = await directory(t);
  const { client, calls } = fixture();
  await assert.rejects(setupProduct({ config, statePath, client }), {
    code: "confirmation_required",
  });
  await setupProduct({ config, statePath, client, confirmed: true });
  await assert.rejects(
    setupProduct({
      config: { ...config, product: { ...config.product, price_jpy: 5000 } },
      statePath,
      client,
      confirmed: true,
    }),
    { code: "state_mismatch" },
  );
  assert.equal(calls.length, 1);
});
test("停止後のリンク取得再試行は商品を重複作成しない", async (t) => {
  const statePath = await directory(t);
  const { client, calls, link } = fixture();
  client.checkoutLinks.get = async () => {
    throw new Error("通信障害");
  };
  await assert.rejects(
    setupProduct({ config, statePath, client, confirmed: true }),
  );
  client.checkoutLinks.get = async () => link;
  await setupProduct({ config, statePath, client, confirmed: true });
  assert.equal(calls.length, 1);
});
test("無効リンク・アーカイブ商品・別商品のリンクを復活させない", async (t) => {
  for (const kind of ["disabled", "archived", "other"]) {
    const statePath = await directory(t);
    const { client, product, link } = fixture();
    if (kind === "disabled") link.disabled = true;
    if (kind === "archived") product.status = "archived";
    if (kind === "other") link.product_id = "prd_other";
    await assert.rejects(
      setupProduct({ config, statePath, client, confirmed: true }),
    );
  }
});
test("ページングで全候補を取得し、不正な循環cursorで止まる", async () => {
  const { client, product } = fixture();
  client.products.list = async ({ cursor }) =>
    cursor
      ? { items: [{ ...product, id: "prd_older" }], next_cursor: null }
      : { items: [product], next_cursor: "opaque" };
  assert.equal((await inspectProducts({ config, client })).length, 2);
  client.products.list = async () => ({ items: [], next_cursor: "repeated" });
  await assert.rejects(inspectProducts({ config, client }), {
    code: "invalid_pagination",
  });
});
test("同時実行のロックと破損状態を検出してPOSTしない", async (t) => {
  const statePath = await directory(t);
  const { client, calls } = fixture();
  await writeFile(`${statePath}.lock`, "");
  await assert.rejects(
    setupProduct({ config, statePath, client, confirmed: true }),
    { code: "setup_locked" },
  );
  await rm(`${statePath}.lock`);
  await writeFile(statePath, "破損JSON");
  await assert.rejects(
    setupProduct({ config, statePath, client, confirmed: true }),
    { code: "invalid_state" },
  );
  assert.equal(calls.length, 0);
});

test("Next設定は保存応答から自動配線し既存認証・秘密を保持する", async (t) => {
  const { configureNext } = await import("./configure-next.mjs");
  const statePath = await directory(t);
  const envPath = `${statePath}.env`;
  const { client } = fixture();
  await setupProduct({ config, statePath, client, confirmed: true });
  await writeFile(
    envPath,
    '# 既存設定\nAUTH_SECRET="テスト専用の秘密"\nCOZENI_PRODUCT_ID="古いID"\n',
  );
  await configureNext(statePath, envPath);
  await configureNext(statePath, envPath);
  const environment = await readFile(envPath, "utf8");
  assert.ok(environment.includes('AUTH_SECRET="テスト専用の秘密"'));
  assert.ok(environment.includes('COZENI_PRODUCT_ID="prd_test"'));
  assert.equal(environment.match(/COZENI_PRODUCT_ID=/g).length, 1);
  assert.ok(environment.includes('COZENI_SITE_ORIGIN="http://127.0.0.1:3100"'));
});

test("Windowsネイティブでは状態・lock・APIを変更する前に停止する", async (t) => {
  const statePath = await directory(t);
  const { client, calls } = fixture();
  let accountCalls = 0;
  client.account.get = async () => {
    accountCalls++;
    throw new Error("呼出禁止");
  };
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(
      setupProduct({ config, statePath, client, confirmed: true }),
      { code: "unsupported_platform" },
    );
  } finally {
    Object.defineProperty(process, "platform", original);
  }
  assert.equal(accountCalls, 0);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  await assert.rejects(readFile(`${statePath}.lock`), { code: "ENOENT" });
});

test("directory fsync失敗を握り潰さず商品POST前に停止する", async (t) => {
  const statePath = await directory(t);
  const { client, calls } = fixture();
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (path, flags, ...args) => {
    const handle = await originalOpen(path, flags, ...args);
    if (flags === "r") {
      handle.sync = async () => {
        throw Object.assign(new Error("永続化失敗"), { code: "EIO" });
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      setupProduct({ config, statePath, client, confirmed: true }),
      { code: "EIO" },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).phase, "prepared");
  await assert.rejects(readFile(`${statePath}.lock`), { code: "ENOENT" });
});

test("Next設定CLIは既知の停止コードを示し、未知例外と入力の秘密は出さない", async (t) => {
  const statePath = await directory(t);
  const envPath = `${statePath}.env`;
  const script = new URL("./configure-next.mjs", import.meta.url);
  const invoke = () =>
    spawnSync(process.execPath, [script.pathname, statePath, envPath], {
      encoding: "utf8",
    });
  for (const [code, state] of [
    [
      "setup_incomplete",
      {
        config,
        phase: "prepared",
        productId: "秘密の入力",
        checkoutUrl: "https://example.com",
      },
    ],
    ["invalid_config", { config: { ...config, creatorId: "" } }],
    [
      "invalid_environment_value",
      {
        config,
        phase: "complete",
        productId: "秘密の入力\n",
        checkoutUrl: "https://example.com",
      },
    ],
    [
      "checkout_link_unusable",
      {
        config,
        phase: "complete",
        productId: "秘密の入力",
        checkoutUrl: "https://secret:password@example.com",
      },
    ],
  ]) {
    await writeFile(statePath, JSON.stringify(state));
    const result = invoke();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`(${code})`));
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(statePath));
    assert.ok(!result.stderr.includes("秘密の入力"));
    assert.ok(!result.stderr.includes("password"));
    await assert.rejects(readFile(envPath), { code: "ENOENT" });
  }
  await writeFile(statePath, "秘密の不正JSON");
  const result = invoke();
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("接続設定を保存できませんでした"));
  assert.ok(!result.stderr.includes("秘密の不正JSON"));
  assert.ok(!result.stderr.includes(statePath));
  await rm(statePath);
  assert.ok(!invoke().stderr.includes(statePath));
});
