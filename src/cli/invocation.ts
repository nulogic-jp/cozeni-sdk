// 案内に出すCLIの呼び出し名。
// init以降はSDKがプロジェクトの依存に入っている前提で、binの `cozeni` を `--no` 付きで呼ぶ。
// `--no` があれば、SDKが入っていない場所でもnpxはレジストリから取得せずに止まる
// （スコープなしの名前は、入っていなければ別のパッケージが実行されうる）。
// 直後の `--help`・`--version` はnpxが自分のオプションとして受け取るため、使い方は `help` で案内する。
export const CLI = "npx --no cozeni";
// initはSDKを入れる前に打つため、スコープ付きの名前で呼ぶ。
export const INIT_CLI = "npx @nulogic/cozeni-sdk";
