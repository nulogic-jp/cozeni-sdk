// 配布物とリポジトリの双方で使う、公開してはいけない内容の定義。
// 検査対象が増えてもここ1箇所を直せば両方へ反映される。

export const forbiddenContent = [
  {
    label: "staging URL",
    pattern:
      /(?:https?:\/\/)?(?:api|app|checkout)-stg\.cozeni\.net(?=[:/?#\s"'`]|$)/giu,
  },
  {
    label: "private本体リポジトリ参照",
    pattern: /nulogic-jp\/cozeni(?!-sdk)(?=$|[./#:\s"'`])/giu,
  },
  {
    label: "移行元privateリポジトリ参照",
    pattern: /cozeni-private-sdk/giu,
  },
  {
    label: "private PR番号",
    pattern: /\b(?:PR|pull request)\s*#\s*\d+\b|\/pull\/\d+\b/giu,
  },
  {
    label: "40桁のコミットSHA",
    pattern: /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/giu,
  },
  {
    label: "秘密鍵",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
  },
  {
    label: "GitHub token",
    pattern:
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gu,
  },
  {
    label: "npm token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/gu,
  },
  {
    label: "Stripe secret key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  },
  {
    label: "Stripe publishable key",
    pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  },
  {
    label: "Stripe webhook secret",
    pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/gu,
  },
  {
    label: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/gu,
  },
  {
    label: "Cozeni API key",
    pattern: /\bcozeni_(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/gu,
  },
  {
    label: "JWT",
    pattern:
      /\beyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu,
  },
  {
    label: "URL埋め込み認証情報",
    pattern:
      /https?:\/\/(?![^\s/@]+@(?:example\.(?:com|net|org)|[^\s/@]+\.(?:test|invalid|example))(?=[:/?#\s"'`]|$))[^\s/:@]+:[^\s/@]+@[^\s/]+/giu,
  },
];

export function isAllowedExampleEmail(email) {
  const [local, domain] = email.toLowerCase().split("@");
  return (
    /(?:^|[+._-])(?:example|test|fixture|dummy)(?:$|[+._-])/.test(local) ||
    /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid)$/.test(domain)
  );
}

/** 本文からメールアドレスらしき文字列を拾う。example系の判定は呼び出し側で行う。 */
export const emailPattern =
  /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])/giu;
