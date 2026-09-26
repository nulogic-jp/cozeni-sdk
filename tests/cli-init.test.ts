import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliContext, run } from "../src/cli/run.js";
import { createStore } from "../src/cli/store.js";

const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version as string;
const skillSource = new URL("../skills/cozeni-setup/", import.meta.url);

let temporary: string;
let home: string;
let project: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "cozeni-init-"));
  home = join(temporary, "home");
  project = join(temporary, "site");
  await mkdir(home);
  await mkdir(project);
  // 探索を一時ディレクトリの外へ出さない。
  await mkdir(join(project, ".git"));
  await writeFile(join(project, "package.json"), '{"name":"site"}\n');
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function cli(
  options: {
    env?: Record<string, string>;
    cwd?: string;
    install?: (
      command: string,
      args: string[],
      cwd: string,
      env: Record<string, string | undefined>,
    ) => Promise<{ code: number | null; error?: string }>;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runCommand = vi.fn(
    options.install ??
      (async (_command: string, _args: string[], cwd: string) => {
        // 実際の install の代わりに、依存と node_modules を書く。
        const path = join(cwd, "package.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.dependencies = {
          ...manifest.dependencies,
          "@nulogic/cozeni-sdk": version,
        };
        await writeFile(path, JSON.stringify(manifest));
        await mkdir(join(cwd, "node_modules", "@nulogic", "cozeni-sdk"), {
          recursive: true,
        });
        await writeFile(
          join(cwd, "node_modules", "@nulogic", "cozeni-sdk", "package.json"),
          JSON.stringify({ name: "@nulogic/cozeni-sdk", version }),
        );
        return { code: 0 };
      }),
  );
  const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
  const context = (argv: string[]): CliContext => ({
    argv,
    env: { XDG_CONFIG_HOME: home, HOME: home, ...options.env },
    cwd: options.cwd ?? project,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
    interactiveTerminal: false,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => Date.parse("2026-09-25T00:00:00.000Z"),
    sleep: async () => {},
    openBrowser: () => {},
    prompt: async () => "n",
    onLine: () => () => {},
    runCommand,
  });
  return {
    runCommand,
    fetch,
    async run(...argv: string[]) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await run(context(argv));
      return { code, out: stdout.join(""), err: stderr.join("") };
    },
    parsed() {
      const text = stdout.join("");
      expect(text.trim().split("\n")).toHaveLength(1);
      return JSON.parse(text);
    },
  };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const files = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name).slice(directory.length + 1),
    )
    .sort();

describe("init", () => {
  it("SDKを厳密な版で入れ、skillを置き、既定の設定を0600で保存する", async () => {
    const t = cli();
    const { code, out } = await t.run("init", "--creator", "cre_abc", "--json");
    expect(code).toBe(0);
    expect(out).not.toContain("api_key");
    expect(t.runCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "--save-exact", `@nulogic/cozeni-sdk@${version}`],
      project,
      expect.any(Object),
    );
    const data = t.parsed().data;
    expect(data).toMatchObject({
      project_root: project,
      package_manager: "npm",
      sdk: { version, installed: true },
      skills: [{ path: ".agents/skills/cozeni-setup", status: "created" }],
      profile: "production",
      api_origin: "https://api.cozeni.net",
      app_origin: "https://app.cozeni.net",
      expected_creator_id: "cre_abc",
      next_step: "npx --no cozeni login",
    });
    expect(await files(join(project, ".agents/skills/cozeni-setup"))).toEqual(
      await files(skillSource.pathname.replace(/\/$/, "")),
    );
    expect(await mode(join(home, "cozeni"))).toBe(0o700);
    expect(await mode(join(home, "cozeni", "config.json"))).toBe(0o600);
    expect(await createStore({ XDG_CONFIG_HOME: home }).loadConfig()).toEqual({
      version: 1,
      default_profile: "production",
      profiles: { production: { expected_creator_id: "cre_abc" } },
    });
    // credentials.json には触れない。
    expect(await readdir(join(home, "cozeni"))).toEqual(["config.json"]);
  });
  it.each([
    ["bun.lock", "bun", ["add", "--exact"]],
    ["bun.lockb", "bun", ["add", "--exact"]],
    ["pnpm-lock.yaml", "pnpm", ["add", "--save-exact"]],
    ["yarn.lock", "yarn", ["add", "--exact"]],
    ["package-lock.json", "npm", ["install", "--save-exact"]],
  ])("%sがあれば%sで入れる", async (lockfile, command, args) => {
    await writeFile(join(project, lockfile), "");
    const t = cli();
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      0,
    );
    expect(t.runCommand).toHaveBeenCalledWith(
      command,
      [...args, `@nulogic/cozeni-sdk@${version}`],
      project,
      expect.any(Object),
    );
    expect(t.parsed().data.package_manager).toBe(command);
  });
  it("サブディレクトリから実行しても、package.jsonのある場所をルートにする", async () => {
    await writeFile(join(project, "pnpm-lock.yaml"), "");
    await mkdir(join(project, "src", "app"), { recursive: true });
    const t = cli({ cwd: join(project, "src", "app") });
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      0,
    );
    expect(t.runCommand).toHaveBeenCalledWith(
      "pnpm",
      expect.any(Array),
      project,
      expect.any(Object),
    );
    await lstat(join(project, ".agents/skills/cozeni-setup/SKILL.md"));
  });
  it("ワークスペースの上位にあるlockfileでpackage managerを決める", async () => {
    await writeFile(join(project, "bun.lock"), "");
    const app = join(project, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), '{"name":"web"}');
    const t = cli({ cwd: app });
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      0,
    );
    expect(t.runCommand).toHaveBeenCalledWith(
      "bun",
      expect.any(Array),
      app,
      expect.any(Object),
    );
  });
  it("package.jsonが無ければinvalid_inputで、何もしない", async () => {
    const empty = join(temporary, "empty");
    await mkdir(join(empty, ".git"), { recursive: true });
    const t = cli({ cwd: empty });
    const { code } = await t.run("init", "--creator", "cre_abc", "--json");
    expect(code).toBe(2);
    expect(t.parsed().error.code).toBe("invalid_input");
    expect(t.runCommand).not.toHaveBeenCalled();
    await expect(lstat(join(home, "cozeni"))).rejects.toThrow();
  });
  it("同じ版が依存に入っていれば入れ直さない", async () => {
    const t = cli();
    await t.run("init", "--creator", "cre_abc", "--json");
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(t.runCommand).toHaveBeenCalledTimes(1);
    expect(t.parsed().data).toMatchObject({
      sdk: { version, installed: false },
      skills: [{ path: ".agents/skills/cozeni-setup", status: "unchanged" }],
    });
  });
  it("installが失敗したら終了コードと短い理由を返し、出力を転記しない", async () => {
    const t = cli({ install: async () => ({ code: 1 }) });
    const { code, out } = await t.run("init", "--creator", "cre_abc", "--json");
    expect(code).toBe(1);
    const error = t.parsed().error;
    expect(error).toMatchObject({
      code: "install_failed",
      exit_code: 1,
      command: `npm install --save-exact @nulogic/cozeni-sdk@${version}`,
    });
    expect(out).not.toContain("npm ERR");
    expect(error.hint).toContain("npm install");
  });
  it("package managerが見つからなければ、そう伝える", async () => {
    const t = cli({
      install: async () => ({ code: null, error: "ENOENT" }),
    });
    await writeFile(join(project, "pnpm-lock.yaml"), "");
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      1,
    );
    expect(t.parsed().error.message).toContain("pnpm");
  });
  it("Claude Codeの実行環境では.claude/skillsにもコピーする（リンクにしない）", async () => {
    const t = cli({ env: { CLAUDECODE: "1" } });
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(t.parsed().data.skills).toEqual([
      { path: ".agents/skills/cozeni-setup", status: "created" },
      { path: ".claude/skills/cozeni-setup", status: "created" },
    ]);
    const stats = await lstat(join(project, ".claude/skills/cozeni-setup"));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isDirectory()).toBe(true);
  });
  it("プロジェクトに.claude/があれば.claude/skillsにもコピーする", async () => {
    await mkdir(join(project, ".claude"));
    const t = cli();
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(
      t.parsed().data.skills.map((skill: { path: string }) => skill.path),
    ).toContain(".claude/skills/cozeni-setup");
  });
  it("既存のskillが違えば自分の版で置き換え、余分なファイルも残さない", async () => {
    const target = join(project, ".agents/skills/cozeni-setup");
    await mkdir(join(target, "scripts"), { recursive: true });
    await writeFile(join(target, "SKILL.md"), "古い版");
    await writeFile(join(target, "scripts", "old.mjs"), "");
    const t = cli();
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(t.parsed().data.skills[0].status).toBe("updated");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
      await readFile(new URL("SKILL.md", skillSource), "utf8"),
    );
    expect(await files(target)).toEqual(
      await files(skillSource.pathname.replace(/\/$/, "")),
    );
    // 置き換えの途中のディレクトリを残さない。
    expect(await readdir(join(project, ".agents/skills"))).toEqual([
      "cozeni-setup",
    ]);
  });
  it("シンボリックリンクのskillは、リンク先を消さずに実体のコピーへ置き換える", async () => {
    const outside = join(temporary, "shared-skill");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "外の skill");
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await symlink(outside, join(project, ".claude/skills/cozeni-setup"));
    const t = cli();
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(
      (await lstat(join(project, ".claude/skills/cozeni-setup"))).isDirectory(),
    ).toBe(true);
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(
      "外の skill",
    );
  });
  it("production以外は接続先を必須にし、プロファイルと一緒に保存する", async () => {
    const t = cli();
    expect(
      (
        await t.run(
          "init",
          "--creator",
          "cre_abc",
          "--profile",
          "staging",
          "--json",
        )
      ).code,
    ).toBe(2);
    expect(t.runCommand).not.toHaveBeenCalled();
    const { code } = await t.run(
      "init",
      "--creator",
      "cre_abc",
      "--profile",
      "staging",
      "--api-origin",
      "https://api.staging.example/",
      "--app-origin",
      "https://app.staging.example",
      "--json",
    );
    expect(code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      profile: "staging",
      api_origin: "https://api.staging.example",
      next_step: "npx --no cozeni login",
    });
    expect(
      await createStore({ XDG_CONFIG_HOME: home }).loadConfig(),
    ).toMatchObject({
      default_profile: "staging",
      profiles: {
        staging: {
          expected_creator_id: "cre_abc",
          api_origin: "https://api.staging.example",
          app_origin: "https://app.staging.example",
        },
      },
    });
  });
  it("productionの接続先は変えられない", async () => {
    const t = cli();
    expect(
      (
        await t.run(
          "init",
          "--creator",
          "cre_abc",
          "--api-origin",
          "https://evil.example",
          "--json",
        )
      ).code,
    ).toBe(2);
    expect(t.runCommand).not.toHaveBeenCalled();
  });
  it("他のプロファイルの設定を残す", async () => {
    const t = cli();
    await t.run(
      "init",
      "--creator",
      "cre_dev",
      "--profile",
      "dev",
      "--api-origin",
      "http://localhost:8787",
      "--app-origin",
      "http://localhost:5173",
      "--json",
    );
    await t.run(
      "init",
      "--creator",
      "cre_abc",
      "--profile",
      "production",
      "--json",
    );
    const config = await createStore({ XDG_CONFIG_HOME: home }).loadConfig();
    expect(config.default_profile).toBe("production");
    expect(config.profiles.dev?.expected_creator_id).toBe("cre_dev");
  });
  it.each(["crt_abc", "cre_", "cre_a b", "abc"])(
    "--creator %s は形式の誤り",
    async (creator) => {
      const t = cli();
      expect((await t.run("init", "--creator", creator, "--json")).code).toBe(
        2,
      );
      expect(t.runCommand).not.toHaveBeenCalled();
    },
  );
  it("--creatorを省略したら、保存済みの期待するクリエイターを使う", async () => {
    const t = cli();
    expect((await t.run("init", "--json")).code).toBe(2);
    await t.run("init", "--creator", "cre_abc", "--json");
    expect((await t.run("init", "--json")).code).toBe(0);
    expect(t.parsed().data.expected_creator_id).toBe("cre_abc");
  });
  it("通信しない", async () => {
    const t = cli();
    await t.run("init", "--creator", "cre_abc", "--json");
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it("人向けの表示は、次にやることを日本語で示す", async () => {
    const t = cli();
    const { code, out } = await t.run("init", "--creator", "cre_abc");
    expect(code).toBe(0);
    expect(out).toContain("npx --no cozeni login");
    expect(out).toContain("cre_abc");
  });

  const devArgs = [
    "--profile",
    "dev",
    "--api-origin",
    "http://localhost:8787",
    "--app-origin",
    "http://localhost:5173",
  ];
  it("--profileを省略した再実行では、既定のプロファイルを引き継ぐ", async () => {
    const t = cli();
    await t.run("init", "--creator", "cre_dev", ...devArgs, "--json");
    expect((await t.run("init", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      profile: "dev",
      api_origin: "http://localhost:8787",
      expected_creator_id: "cre_dev",
    });
    const config = await createStore({ XDG_CONFIG_HOME: home }).loadConfig();
    expect(config.default_profile).toBe("dev");
    expect(config.profiles.dev).toEqual({
      expected_creator_id: "cre_dev",
      api_origin: "http://localhost:8787",
      app_origin: "http://localhost:5173",
    });
  });
  it("保存済みのカスタムプロファイルは--profileだけで再初期化でき、接続先を再要求しない", async () => {
    const t = cli();
    await t.run("init", "--creator", "cre_dev", ...devArgs, "--json");
    await t.run(
      "init",
      "--creator",
      "cre_abc",
      "--profile",
      "production",
      "--json",
    );
    expect((await t.run("init", "--profile", "dev", "--json")).code).toBe(0);
    expect(t.parsed().data).toMatchObject({
      profile: "dev",
      api_origin: "http://localhost:8787",
      app_origin: "http://localhost:5173",
    });
    expect(
      (await createStore({ XDG_CONFIG_HOME: home }).loadConfig())
        .default_profile,
    ).toBe("dev");
  });
  it("package managerにCozeniの秘密を渡さず、package managerの認証設定は渡す", async () => {
    const t = cli({
      env: {
        COZENI_API_KEY: "cozeni_env_secret",
        COZENI_API_ORIGIN: "https://api.cozeni.net",
        NPM_TOKEN: "npm_user_token",
        PATH: "/usr/bin",
      },
    });
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      0,
    );
    const env = t.runCommand.mock.calls[0]?.[3] as Record<string, string>;
    expect(Object.keys(env).filter((key) => key.startsWith("COZENI_"))).toEqual(
      [],
    );
    expect(env.NPM_TOKEN).toBe("npm_user_token");
    expect(env.PATH).toBe("/usr/bin");
  });
  it("package.jsonのpackageManagerをlockfileより優先する", async () => {
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "site", packageManager: "pnpm@9.1.0" }),
    );
    const t = cli();
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      0,
    );
    expect(t.runCommand.mock.calls[0]?.[0]).toBe("pnpm");
    expect(t.parsed().data.package_manager).toBe("pnpm");
  });
  it("packageManagerとlockfileが矛盾すれば、選ばずにpackage_manager_conflictで止める", async () => {
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "site", packageManager: "pnpm@9.1.0" }),
    );
    await writeFile(join(project, "yarn.lock"), "");
    const t = cli();
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      1,
    );
    const error = t.parsed().error;
    expect(error.code).toBe("package_manager_conflict");
    expect(error.message).toContain("pnpm");
    expect(error.message).toContain("yarn");
    expect(t.runCommand).not.toHaveBeenCalled();
    await expect(lstat(join(project, ".agents"))).rejects.toThrow();
  });
  it.each([".agents", ".agents/skills", ".claude", ".claude/skills"])(
    "配置先の途中の%sがシンボリックリンクなら、書き込まずにunsafe_pathで止める",
    async (link) => {
      const outside = join(temporary, "outside");
      await mkdir(outside);
      const parent = join(project, link, "..");
      await mkdir(parent, { recursive: true });
      await symlink(outside, join(project, link));
      const t = cli({ env: { CLAUDECODE: "1" } });
      const { code } = await t.run("init", "--creator", "cre_abc", "--json");
      expect(code).toBe(1);
      expect(t.parsed().error.code).toBe("unsafe_path");
      expect(await readdir(outside)).toEqual([]);
      await expect(
        lstat(join(home, "cozeni", "config.json")),
      ).rejects.toThrow();
    },
  );
  it("配置先の途中がディレクトリでなければunsafe_pathで止める", async () => {
    await writeFile(join(project, ".agents"), "");
    const t = cli();
    expect((await t.run("init", "--creator", "cre_abc", "--json")).code).toBe(
      1,
    );
    expect(t.parsed().error.code).toBe("unsafe_path");
  });
});
