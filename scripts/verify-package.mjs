import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  "README.md",
  "LICENSE",
  "skills/cozeni-setup/SKILL.md",
  "skills/cozeni-setup/references/javascript-server.md",
  "skills/cozeni-setup/references/nextjs.md",
  "skills/cozeni-setup/scripts/setup.mjs",
  "skills/cozeni-setup/scripts/configure-next.mjs",
  "examples/nextjs/app/page.tsx",
  "examples/nextjs/app/members/page.tsx",
  "examples/nextjs/app/members/actions.ts",
  "examples/nextjs/app/api/protected/route.ts",
  "examples/nextjs/app/cozeni/handoff/route.ts",
  "examples/nextjs/app/cozeni/clear/route.ts",
  "examples/nextjs/lib/cozeni.ts",
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

  console.log(
    `配布検証成功: ${packed.name}@${packed.version} / ${files.length}ファイル / SDK・skill・examples / 内部情報・秘密なし`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
