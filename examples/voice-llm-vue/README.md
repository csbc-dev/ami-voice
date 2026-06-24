# `voice-llm-vue` — 配線だけで音声 → LLM（Vue 版）

[`voice-llm`](../voice-llm/) と同じ「マイク → 文字起こし → LLM 要約」デモの **Vue 3 版**です。
合成するコンポーネントもサーバも同じ（`<ami-voice>` + `<ai-agent>`、1プロセスに2つの Core）。
違うのは**フロントのバインドの書き方だけ**です。

```
🎤 ブラウザ        🖥 サーバ（1プロセスに2つの Core）          ☁ 外部
─────────         ──────────────────────────────────         ────────
<ami-voice> ──控制 JSON──▶ AmiVoiceCore  ──relay──▶ AmiVoice WSS
   │  └──音声バイナリ──────▶  (APPKEY 常駐)
   │
   ▼ transcript（配線 = watch 一つ）
<ai-agent>  ──prompt/send─▶ AiCore        ──fetch──▶ Claude / OpenAI 等
              ◀─content────  (API キー常駐)
```

両方の秘密（`AMIVOICE_APPKEY` と `AI_API_KEY`）はサーバから出ません。ブラウザが受け取るのは
**状態だけ**（`transcript`, `content` …）です。

## なぜ Vue 版を別に置くのか — バニラ版との違い

[`voice-llm`](../voice-llm/)（バニラ JS）は、`@wc-bindable/core` の `bind()` コールバックで
`transcript → DOM`・`content → DOM` の**射影を手書き**します。フレームワークが無いぶん、
その射影コード（2つの `bind()` switch・`createElement`・DOM 参照）が `main.ts` の大半を占め、
「タグにした旨味」が見えにくくなります。

この Vue 版は、その射影を **`@wc-bindable/vue` の `useWcBindable` に委譲**します。
`<ami-voice>` / `<ai-agent>` の reactive な状態がそのままテンプレートに流れ込むので、
**アプリ側に残るのは「いつ要約するか」の `watch` 一つだけ**になります。

| | `voice-llm`（バニラ） | `voice-llm-vue`（この例） |
|---|---|---|
| 状態 → 画面 | `bind(el, (name,value)=>switch{…})` を手書き×2 | テンプレートに `{{ ami.transcript }}` / `{{ aiv.content }}` |
| 要素の宣言 | `createElement` + `setAttribute` を JS で | `<ami-voice :engine=… />` を**テンプレートに宣言** |
| 配線の本体 | `bind` の `recognizing` ケース内 | `watch(() => ami.recognizing, …)` |
| バインド層 | `@wc-bindable/core` | `@wc-bindable/vue`（`useWcBindable`） |

→ 同じ「消えた配線」（getUserMedia / AudioWorklet / WSS / SSE / トークン蓄積 / abort / 鍵管理）に
加えて、**プレゼンの射影コードも消える**のがフレームワーク版の効きどころです。

> 宣言バインドの最小単体（`<ami-voice>` 1つだけ）は [`../vue/`](../vue/) を参照。
> こちらはそれを**2コンポーネント合成 + LLM 連携**に広げた版です。

## 構成

| ファイル | 役割 |
|---|---|
| [`src/App.vue`](src/App.vue) | ★ 本体。`useWcBindable` で両要素を宣言バインドし、`watch` 一つで `transcript → prompt → send()`。 |
| [`src/main.ts`](src/main.ts) | `bootstrapAmiVoice()` / `bootstrapAi()` で両タグを登録して mount。 |
| [`server.mjs`](server.mjs) | 1プロセスに2つの Core を同居。WS は `/ai-agent` のみ `<ai-agent>`、それ以外は `<ami-voice>` リレーへ。 |
| [`fakes.mjs`](fakes.mjs) | 鍵なしで動かすためのフェイク（AmiVoice 上流 + OpenAI 互換 SSE）。 |

> 補足: 同階層の [`zenn-draft.md`](zenn-draft.md) は、この構成（音声 → LLM を配線だけで）を題材にした **Zenn 記事の下書き**（`published: false`）です。スニペットはこの Vue 版に対応します。サンプルの動作には関係しません。

## 動かす

```bash
cd examples/voice-llm-vue
npm install
```

### 1. サーバを起動（秘密はここに常駐）

```bash
npm run server            # http://localhost:3200
```

鍵を一切設定しなければ **完全オフライン**で動きます（フェイクの AmiVoice 上流＋フェイク LLM）。
本物につなぐときは `.env`（[`.env.example`](.env.example) 参照）に鍵を入れて再起動：

```bash
AMIVOICE_APPKEY=...     # 音声認識を本物に（無料トライアル＋クーポンは https://acp.amivoice.com/）
AI_PROVIDER=anthropic
AI_MODEL=claude-haiku-4-5
AI_API_KEY=sk-ant-...   # LLM を本物に
```

> ⚠ **Auth はシーム（接合点）であって既定ではない。** `server.mjs` は誰でも受け付けるので
> オフラインで動きます。本番では relay ハンドラの前で peer を認証してください
> （[SPEC.md §14](../../SPEC.md)）。

### 2. クライアントを起動

```bash
npm run dev               # 表示された URL（例 http://localhost:5173）を開く
# npm run build           # 本番ビルド（dist/）。"build OK" の確認用
```

マイクを許可（Chrome 推奨）→ 話す → **Stop** で自動的に LLM 要約が走ります。
「Stop で自動要約」のチェックを外せば、ボタン手動でも実行できます。

## 「配線」とは具体的に

[`src/App.vue`](src/App.vue) の本質はこれだけです：

```ts
// <ami-voice> の確定テキストを <ai-agent> の prompt に流して send() するだけ
function summarize() {
  if (!ami.transcript.trim()) return;     // 空ガード
  aiEl.value!.prompt = ami.transcript;
  aiEl.value!.send();
}
// 唯一のポリシー判断：認識が止まったら（Stop）一度だけ要約する（auto オン時）。
watch(() => ami.recognizing, (now, prev) => {
  if (prev && !now && auto.value) summarize();
});
```

> この `watch` は「確定テキスト（`transcript`）の更新が `recognizing→false` より先に届く」という
> Core 側の発火順に乗っています。万一その順序が崩れる環境では確定が一拍遅れて反映されうるため、
> `summarize()` 冒頭の空ガードが空送信だけは確実に弾きます。

状態 → 画面の配線、要素の生成、コマンド呼び出し —— これらは `useWcBindable` とテンプレートが
宣言的に肩代わりし、アプリ側のコードには現れません。残るのは「**いつ** LLM に投げるか」だけです。
