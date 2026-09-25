import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  emailPattern,
  forbiddenContent,
  isAllowedExampleEmail,
} from "./forbidden-content.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const expectedVersion =
  process.env.COZENI_EXPECTED_PACKAGE_VERSION ?? packageJson.version;
const temporary = await mkdtemp(join(tmpdir(), "cozeni-package-check-"));

const requiredFiles = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/next.js",
  "dist/next.d.ts",
  "dist/transport.js",
  "dist/cli/main.js",
  "dist/cli/run.js",
  "README.md",
  "LICENSE",
  "skills/cozeni-setup/SKILL.md",
  "skills/cozeni-setup/references/javascript-server.md",
  "skills/cozeni-setup/references/nextjs.md",
  "examples/nextjs/app/page.tsx",
  "examples/nextjs/app/members/page.tsx",
  "examples/nextjs/app/members/actions.ts",
  "examples/nextjs/app/api/protected/route.ts",
  "examples/nextjs/lib/cozeni.ts",
  "examples/nextjs/lib/content.ts",
  "examples/nextjs/proxy.ts",
  "examples/nextjs/next.config.ts",
  "examples/nextjs/package.json",
  "examples/nextjs/tsconfig.json",
  "examples/nextjs/.env.example",
  "examples/javascript-server/README.md",
  "examples/javascript-server/web-handler.mjs",
  "examples/javascript-server/node-server.mjs",
];

function assertSafePath(path) {
  assert.ok(
    !path.startsWith("/") && !path.split("/").includes(".."),
    `不正なパスが配布物へ混入しています: ${path}`,
  );
  assert.ok(
    !/(^|\/)(?:docs?|tests?|__tests__|fixtures?)(\/|$)/iu.test(path) &&
      !/\.(?:test|spec)\.[^/]+$/iu.test(path),
    `公開不要なdocs・test・fixtureが配布物へ混入しています: ${path}`,
  );
  assert.ok(
    !/(^|\/)(?:node_modules|\.next|\.cozeni|coverage|\.turbo|\.cache|\.git|\.github|\.gitignore|\.gitattributes|\.gitmodules)(\/|$)/u.test(
      path,
    ),
    `ローカル状態またはGit管理情報が配布物へ混入しています: ${path}`,
  );
  assert.ok(
    !/(^|\/)\.env(?:\..+)?$/u.test(path) || path.endsWith("/.env.example"),
    `秘密用環境ファイルが配布物へ混入しています: ${path}`,
  );
  assert.ok(
    !/(^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))(?:$|\/)/iu.test(
      path,
    ),
    `認証情報を含み得るファイルが配布物へ混入しています: ${path}`,
  );
  assert.ok(
    !path.endsWith(".tgz"),
    `tarballが配布物へ再混入しています: ${path}`,
  );
}

function assertSafeText(path, text) {
  for (const { label, pattern } of forbiddenContent) {
    pattern.lastIndex = 0;
    assert.ok(!pattern.test(text), `${label}が配布物へ混入しています: ${path}`);
  }

  emailPattern.lastIndex = 0;
  const emails = text.matchAll(emailPattern);
  for (const [email] of emails) {
    assert.ok(
      isAllowedExampleEmail(email),
      `example/test用途ではないメールアドレスが配布物へ混入しています: ${path}`,
    );
  }
}

try {
  // 実tarballの内容を検証し、公開・ネットワーク接続は行わない。
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
      "--cache",
      join(temporary, "cache"),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // npm 11までは配列、npm 12からはpackage名をキーにしたオブジェクトを返す。
  const parsed = JSON.parse(output);
  const [packed] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.equal(packed.name, packageJson.name);
  assert.equal(packed.version, expectedVersion);

  const files = packed.files.map((entry) => entry.path);
  for (const required of requiredFiles) {
    assert.ok(
      files.includes(required),
      `配布物に必要なファイルがありません: ${required}`,
    );
  }
  for (const path of files) assertSafePath(path);

  // npmの一覧だけでなく、作成された実アーカイブにも同じファイルがあることを確認する。
  const archive = join(temporary, packed.filename);
  const entries = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.deepEqual(
    entries.sort(),
    files.map((path) => `package/${path}`).sort(),
  );

  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  for (const path of files) {
    const extracted = join(temporary, "package", path);
    const stats = await lstat(extracted);
    assert.ok(
      stats.isFile(),
      `通常ファイルではない項目が配布物にあります: ${path}`,
    );

    const content = await readFile(extracted);
    // バイナリはNULを含むものとして除外し、tarball内の全文字ファイルを監査する。
    if (!content.includes(0)) assertSafeText(path, content.toString("utf8"));
  }

  // root export（"."）は素のNode ESM importだけで動く契約（"next/headers"等の
  // Next.js固有依存を持たない）。サブパスexport（"./next"）はNext.jsのバンドラ
  // 経由専用でこの検査の対象外（README参照）。
  const distIndexUrl = pathToFileURL(
    join(temporary, "package", "dist/index.js"),
  ).href;
  const loaded = await import(distIndexUrl);
  for (const name of [
    "createManagementClient",
    "createCustomerClient",
    "CozeniError",
    "trustedSiteUrl",
    "customerCookie",
    "clearCustomerCookie",
    "enterRedirectUrl",
    "enterRedirectResponse",
  ]) {
    assert.equal(
      typeof loaded[name],
      "function",
      `root exportを素のNode ESMでimportしたときに${name}が見つかりません。`,
    );
  }

  // CLIは依存（server-only・next）を入れていない展開先でも、素のNodeで起動できる
  // （`/next`を読み込まない）。npxで実行される入口とbinの対応も確かめる。
  const manifest = JSON.parse(
    await readFile(join(temporary, "package", "package.json"), "utf8"),
  );
  assert.equal(manifest.bin?.cozeni, "dist/cli/main.js");
  const cli = join(temporary, "package", "dist/cli/main.js");
  assert.ok(
    (await readFile(cli, "utf8")).startsWith("#!/usr/bin/env node\n"),
    "CLIの入口にshebangがありません。",
  );
  const home = join(temporary, "cli-home");
  await mkdir(home);
  const cliEnvironment = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
  };
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], {
      env: cliEnvironment,
      encoding: "utf8",
    }).trim(),
    packed.version,
  );
  // 未ログインの状態で、通信せずに終了コード3とJSONの案内を返す。
  let loginRequired;
  try {
    execFileSync(process.execPath, [cli, "whoami", "--json"], {
      env: cliEnvironment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    loginRequired = error;
  }
  assert.equal(loginRequired?.status, 3);
  assert.equal(JSON.parse(loginRequired.stdout).error.code, "login_required");

  // init は配布物の中の skill を見つけてコピーできる。同じ版を入れ済みの
  // プロジェクトにして、package manager を起動させない（通信しない）。
  const site = join(temporary, "site");
  const installed = join(site, "node_modules", "@nulogic", "cozeni-sdk");
  await mkdir(join(site, ".git"), { recursive: true });
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(site, "package.json"),
    JSON.stringify({
      name: "site",
      dependencies: { "@nulogic/cozeni-sdk": packed.version },
    }),
  );
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ name: "@nulogic/cozeni-sdk", version: packed.version }),
  );
  const initialized = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "init", "--creator", "cre_example", "--json"],
      { cwd: site, env: cliEnvironment, encoding: "utf8" },
    ),
  );
  assert.equal(initialized.ok, true);
  assert.equal(initialized.data.sdk.installed, false);
  assert.equal(
    await readFile(join(site, ".agents/skills/cozeni-setup/SKILL.md"), "utf8"),
    await readFile(
      join(temporary, "package", "skills/cozeni-setup/SKILL.md"),
      "utf8",
    ),
  );

  console.log(
    `配布検証成功: ${packed.name}@${packed.version} / ${files.length}ファイル / SDK・CLI・skill・examples / 内部情報・秘密なし`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
