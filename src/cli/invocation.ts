// 案内に出すCLIの呼び出し名。
// init以降はSDKがプロジェクトの依存に入っている前提で、binの `cozeni` を呼ぶ。
// 入っていない場所では、npxはNulogicが取得した予約パッケージ `cozeni` を取得し、それは案内を出して終了する（reserved/cozeni）。
export const CLI = "npx cozeni";
// initはSDKを入れる前に打つため、スコープ付きの名前で呼ぶ。
export const INIT_CLI = "npx @nulogic/cozeni-sdk";
