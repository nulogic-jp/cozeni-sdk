import { CHECKOUT_URL } from "../lib/cozeni";

export default function Home() {
  return (
    <main>
      <h1>購入者限定のハンドブック</h1>
      <p>
        買い切り商品の購入リンクと、サーバーで保護されたページの導入例です。
      </p>
      <a href={CHECKOUT_URL}>購入する</a>
      <p>
        <a href="/members">購入者限定ページへ</a>
      </p>
    </main>
  );
}
