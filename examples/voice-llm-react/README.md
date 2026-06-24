# `voice-llm-react` — 配線だけで音声 → LLM（React 版）

[`voice-llm`](../voice-llm/) と同じ「マイク → 文字起こし → LLM 要約」デモの **React 19 版**です。
合成するコンポーネントもサーバも同じ（`<ami-voice>` + `<ai-agent>`、1プロセスに2つの Core）。
違うのは**フロントのバインドの書き方だけ**です（[Vue 版](../voice-llm-vue/)の React 対応）。

```
🎤 ブラウザ        🖥 サーバ（1プロセスに2つの Core）          ☁ 外部
─────────         ──────────────────────────────────         ────────
<ami-voice> ──控制 JSON──▶ AmiVoiceCore  ──relay──▶ AmiVoice WSS
   │  └──音声バイナリ──────▶  (APPKEY 常駐)
   │
   ▼ transcript（配線 = useEffect 一つ）
<ai-agent>  ──prompt/send─▶ AiCore        ──fetch──▶ Claude / OpenAI 等
              ◀─content────  (API キー常駐)
```

両方の秘密（`AMIVOICE_APPKEY` と `AI_API_KEY`）はサーバから出ません。ブラウザが受け取るのは
**状態だけ**（`transcript`, `content` …）です。

## なぜ React 版を別に置くのか — バニラ版との違い

[`voice-llm`](../voice-llm/)（バニラ JS）は、`@wc-bindable/core` の `bind()` コールバックで
`transcript → DOM`・`content → DOM` の**射影を手書き**します。フレームワークが無いぶん、
その射影コード（2つの `bind()` switch・`createElement`・DOM 参照）が `main.ts` の大半を占め、
「タグにした旨味」が見えにくくなります。

この React 版は、その射影を **`@wc-bindable/react` の `useWcBindable` に委譲**します。
`<ami-voice>` / `<ai-agent>` の reactive な状態がそのまま JSX に流れ込むので、
**アプリ側に残るのは「いつ要約するか」の `useEffect` 一つだけ**になります。

| | `voice-llm`（バニラ） | `voice-llm-react`（この例） |
|---|---|---|
| 状態 → 画面 | `bind(el, (name,value)=>switch{…})` を手書き×2 | JSX に `{ami.transcript}` / `{aiv.content}` |
| 要素の宣言 | `createElement` + `setAttribute` を JS で | `<ami-voice engine=… />` を JSX に宣言 |
| 配線の本体 | `bind` の `recognizing` ケース内 | `useEffect(() => …, [ami.recognizing])` |
| バインド層 | `@wc-bindable/core` | `@wc-bindable/react`（`useWcBindable`） |

→ 同じ「消えた配線」（getUserMedia / AudioWorklet / WSS / SSE / トークン蓄積 / abort / 鍵管理）に
加えて、**プレゼンの射影コードも消える**のがフレームワーク版の効きどころです。

> 宣言バインドの最小単体（`<ami-voice>` 1つだけ）は [`../react/`](../react/) を参照。
> こちらはそれを**2コンポーネント合成 + LLM 連携**に広げた版です。Vue 版は [`../voice-llm-vue/`](../voice-llm-vue/)。

## 構成

| ファイル | 役割 |
|---|---|
| [`src/App.tsx`](src/App.tsx) | ★ 本体。`useWcBindable` で両要素を宣言バインドし、`useEffect` 一つで `transcript → prompt → send()`。 |
| [`src/main.tsx`](src/main.tsx) | `bootstrapAmiVoice()` / `bootstrapAi()` で両タグを登録して render。 |
| [`server.mjs`](server.mjs) | 1プロセスに2つの Core を同居。WS は `/ai-agent` のみ `<ai-agent>`、それ以外は `<ami-voice>` リレーへ。 |
| [`fakes.mjs`](fakes.mjs) | 鍵なしで動かすためのフェイク（AmiVoice 上流 + OpenAI 互換 SSE）。 |

## 動かす

```bash
cd examples/voice-llm-react
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

`npm run server` は `--env-file-if-exists=.env` 付きなので、`.env` があれば自動で読み込みます
（無ければそのままオフライン動作）。**サーバは起動時に env を読む**ので、`.env` を変えたら再起動してください。

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

[`src/App.tsx`](src/App.tsx) の本質はこれだけです：

```tsx
// <ami-voice> 要素から確定テキストを読み、<ai-agent> の prompt に流して send()
const summarize = useCallback(() => {
  const amiNode = amiEl.current, aiNode = aiEl.current;
  if (!amiNode || !aiNode) return;
  if (!(amiNode.transcript ?? "").trim()) return;  // 空ガード
  aiNode.prompt = amiNode.transcript;
  void aiNode.send();
}, []);

// 唯一のポリシー判断：認識が止まったら（true→false）一度だけ要約する（auto オン時）。
useEffect(() => {
  if (prevRecognizing.current && !ami.recognizing && autoRef.current) summarize();
  prevRecognizing.current = ami.recognizing;
}, [ami.recognizing, summarize]);
```

状態 → 画面の配線、要素の生成、コマンド呼び出し —— これらは `useWcBindable` と JSX が
宣言的に肩代わりし、アプリ側のコードには現れません。残るのは「**いつ** LLM に投げるか」だけです。
