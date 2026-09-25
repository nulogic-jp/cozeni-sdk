import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDirectory, createStore } from "../src/cli/store.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cozeni-cli-store-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

describe("保存先の決定", () => {
  it("XDG_CONFIG_HOMEの下のcozeniを使う", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/x/config", HOME: "/h" })).toBe(
      "/x/config/cozeni",
    );
  });
  it("XDG_CONFIG_HOMEが無い・相対パスなら~/.config/cozeniを使う", () => {
    expect(configDirectory({ HOME: "/h" })).toBe("/h/.config/cozeni");
    expect(configDirectory({ XDG_CONFIG_HOME: "rel", HOME: "/h" })).toBe(
      "/h/.config/cozeni",
    );
  });
});

describe("認証情報の保存", () => {
  it("ディレクトリ0700・ファイル0600で書き、読み戻せる", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await store.saveCredential("production", {
      api_origin: "https://api.cozeni.net",
      app_origin: "https://app.cozeni.net",
      api_key: "k",
      key_id: "key_1",
      creator_id: "crt_1",
      environment: "production",
      expires_at: "2026-10-25T00:00:00.000Z",
    });
    expect(await mode(join(home, "cozeni"))).toBe(0o700);
    expect(await mode(join(home, "cozeni", "credentials.json"))).toBe(0o600);
    expect((await store.loadCredential("production"))?.key_id).toBe("key_1");
    expect(await store.loadCredential("other")).toBeUndefined();
    // 一時ファイルを残さない。
    expect(await readdir(join(home, "cozeni"))).toEqual(["credentials.json"]);
  });
  it("プロファイルごとに持ち、削除しても他のプロファイルを残す", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    const base = {
      api_origin: "http://localhost:8787",
      app_origin: "http://localhost:5173",
      api_key: "k",
      key_id: "key_a",
      creator_id: "crt_1",
      environment: "development",
      expires_at: "2026-10-25T00:00:00.000Z",
    };
    await store.saveCredential("dev", base);
    await store.saveCredential("dev2", { ...base, key_id: "key_b" });
    await store.removeCredential("dev");
    expect(await store.loadCredential("dev")).toBeUndefined();
    expect((await store.loadCredential("dev2"))?.key_id).toBe("key_b");
  });
  it("書き込みに失敗しても既存ファイルを壊さず一時ファイルを残さない", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await store.savePending("login-production", { a: 1 });
    await expect(
      store.savePending("login-production", { a: 10n }),
    ).rejects.toThrow();
    expect(await store.loadPending("login-production")).toEqual({ a: 1 });
    expect(await readdir(join(home, "cozeni", "pending"))).toEqual([
      "login-production.json",
    ]);
  });
});

describe("安全でない保存状態の拒否", () => {
  it("シンボリックリンクのファイルには書かず、読みもしない", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await mkdir(join(home, "cozeni"), { mode: 0o700 });
    const outside = join(home, "outside.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    await symlink(outside, join(home, "cozeni", "credentials.json"));
    await expect(store.loadCredential("production")).rejects.toMatchObject({
      code: "insecure_storage",
    });
    await expect(
      store.saveCredential("production", {
        api_origin: "https://api.cozeni.net",
        app_origin: "https://app.cozeni.net",
        api_key: "k",
        key_id: "key_1",
        creator_id: "crt_1",
        environment: "production",
        expires_at: "2026-10-25T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "insecure_storage" });
    expect(await readFile(outside, "utf8")).toBe("{}");
  });
  it("0600より広い権限のファイルを拒否する", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await store.savePending("login-production", { a: 1 });
    const path = join(home, "cozeni", "pending", "login-production.json");
    await chmod(path, 0o644);
    await expect(store.loadPending("login-production")).rejects.toMatchObject({
      code: "insecure_storage",
    });
    await expect(
      store.savePending("login-production", { a: 2 }),
    ).rejects.toMatchObject({ code: "insecure_storage" });
  });
  it("グループ・他者が読めるディレクトリを拒否する", async () => {
    await mkdir(join(home, "cozeni"), { mode: 0o755 });
    await chmod(join(home, "cozeni"), 0o755);
    const store = createStore({ XDG_CONFIG_HOME: home });
    await expect(store.loadCredential("production")).rejects.toMatchObject({
      code: "insecure_storage",
    });
  });
  it("シンボリックリンクのディレクトリを拒否する", async () => {
    const real = join(home, "real");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(home, "cozeni"));
    const store = createStore({ XDG_CONFIG_HOME: home });
    await expect(store.savePending("x", {})).rejects.toMatchObject({
      code: "insecure_storage",
    });
  });
  it("壊れたJSONはinvalid_stateにする", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await store.savePending("x", {});
    await writeFile(join(home, "cozeni", "pending", "x.json"), "{", {
      mode: 0o600,
    });
    await expect(store.loadPending("x")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });
  it("待ち状態の名前にパス区切りを受け付けない", async () => {
    const store = createStore({ XDG_CONFIG_HOME: home });
    await expect(store.savePending("../x", {})).rejects.toThrow();
  });
});
