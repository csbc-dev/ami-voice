# `voice-llm` — 配線だけで音声 → LLM

`@csbc-dev/ami-voice`（音声認識）と兄弟パッケージ `@csbc-dev/ai-agent`（LLM）を、
**配線（バインディング）だけ**でつなぐ最小デモです。マイクで話す → 文字起こし →
その確定テキストを LLM に渡して要約、までを「いつ LLM に投げるか」の一行だけで実現します。

```
🎤 ブラウザ        🖥 サーバ（1プロセスに2つの Core）          ☁ 外部
─────────         ──────────────────────────────────         ────────
<ami-voice> ──控制 JSON──▶ AmiVoiceCore  ──relay──▶ AmiVoice WSS
   │  └──音声バイナリ──────▶  (APPKEY 常駐)
   │
   ▼ transcript（配線）
<ai-agent>  ──prompt/send─▶ AiCore        ──fetch──▶ Claude / OpenAI 等
              ◀─content────  (API キー常駐)
```

両方の秘密（`AMIVOICE_APPKEY` と `AI_API_KEY`）はサーバから出ません。ブラウザが受け取るのは
**状態だけ**（`transcript`, `content` …）です。

## 構成

| ファイル | 役割 |
|---|---|
| [`server.mjs`](server.mjs) | 1プロセスに2つの Core を同居。`/` = `<ami-voice>` リレー、`/ai-agent` = `<ai-agent>` リモート。 |
| [`fakes.mjs`](fakes.mjs) | 鍵なしで動かすためのフェイク（AmiVoice 上流 + OpenAI 互換 SSE）。 |
| [`src/main.ts`](src/main.ts) | ★ 配線本体。`transcript → prompt → send()` の一行ポリシー。 |

## 動かす

```bash
cd examples/voice-llm
npm install
```

### 1. サーバを起動（秘密はここに常駐）

```bash
npm run server            # http://localhost:3200
```

鍵を一切設定しなければ **完全オフライン**で動きます（フェイクの AmiVoice 上流＋フェイク LLM）。
マイクで話して Stop すると、ダミーの要約がストリーミングで返ってきます。

本物につなぐときは `.env`（`.env.example` 参照）に鍵を入れて再起動：

```bash
# AmiVoice（無料トライアル＋クーポンは https://acp.amivoice.com/）
AMIVOICE_APPKEY=...     # 音声認識を本物に
# 生成AI（推奨: Anthropic Claude）
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
```

マイクを許可（Chrome 推奨）→ 話す → **Stop** で自動的に LLM 要約が走ります。
「Stop で自動要約」のチェックを外せば、ボタン手動でも実行できます。

## 「配線」とは具体的に

[`src/main.ts`](src/main.ts) の本質はこれだけです：

```ts
// <ami-voice> の確定テキストを <ai-agent> の prompt に流して send() するだけ
function summarize() {
  aiAgent.prompt = transcript;
  aiAgent.send();
}
// 認識が止まったら（Stop）一度だけ呼ぶ、というのが唯一のポリシー判断
if (prevRecognizing && !recognizing) summarize();
```

`getUserMedia` / `AudioWorklet` / WSS フレーミング / SSE パース / トークン蓄積 / abort /
鍵管理 —— これらはすべて2つの Core の内側にあり、アプリ側のコードには現れません。
残るのは「**いつ** LLM に投げるか」という、本来アプリが持つべき判断だけです。
