/**
 * Next.js導入例を、いま作業ツリーにあるSDK（HEAD）の配布物で検証するための
 * 共通ヘルパー。examples/nextjs/package.json は利用者と同じ導入経路を示すため
 * 公開npmのバージョン範囲（`^0.3.0`等）を指す。そのままinstallすると、公開前は
 * 解決できず、公開後はHEADではなく既公開版を検証してしまう。そこでHEADをnpm pack
 * したtarballを一時ディレクトリの複製consumerへ差し込む。配布されるmanifestは
 * 変更しない。verify-example.mjs（vitest + build）とverify-next-runtime.mjs
 * （実HTTP起動）の両方がこのヘルパーを共有し、HEADに対する検証であることを保証する。
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function run(command, args, cwd, env) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

/**
 * HEADをnpm packしたtarballを差し込んだ一時consumerを用意する。呼び出し側は
 * `bun install`等のセットアップを自分で行い、使い終わったらcleanup()すること。
 */
export async function prepareExampleConsumer(prefix) {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  // npm 11までは配列、npm 12からはpackage名をキーにしたオブジェクトを返す。
  const parsed = JSON.parse(
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
  const [packed] = Array.isArray(parsed) ? parsed : Object.values(parsed);
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

  return {
    packed,
    consumer,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}
