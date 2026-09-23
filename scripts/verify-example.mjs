/**
 * Next.js導入例を、いま作業ツリーにあるSDKの配布物で検証する。
 *
 * examples/nextjs/package.json は利用者と同じ導入経路を示すため公開npmの
 * バージョン範囲を指す。そのままCIで install すると、公開前は解決できず、公開後は
 * 作業ツリーではなく既公開版を検証してしまう。そこで検証時だけ、このcommitから
 * packしたtarballを一時ディレクトリの複製へ差し込む。配布される manifest は
 * 変更しない。
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const temporary = await mkdtemp(join(tmpdir(), "cozeni-example-check-"));

function run(command, args, cwd, env) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

try {
  // prepackのbuildは呼び出し側（bun run check）が済ませている。
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporary,
        root,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tarball = join(temporary, packed.filename);

  const consumer = join(temporary, "example");
  await cp(join(root, "examples/nextjs"), consumer, {
    recursive: true,
    filter: (source) =>
      !source.includes("/node_modules") && !source.includes("/.next"),
  });

  const manifest = JSON.parse(
    await readFile(join(consumer, "package.json"), "utf8"),
  );
  manifest.dependencies[packageJson.name] = `file:${tarball}`;
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // manifestを書き換えたのでlockfileは使えない。
  await rm(join(consumer, "bun.lock"), { force: true });

  run("bun", ["install"], consumer);
  run("bun", ["run", "test"], consumer);
  run("bun", ["run", "build"], consumer, { NEXT_TELEMETRY_DISABLED: "1" });

  console.log(
    `導入例検証成功: ${packed.name}@${packed.version} の配布物でNext.js例のテストとビルドが通りました`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
