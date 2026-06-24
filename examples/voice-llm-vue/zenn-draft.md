---
title: "配線だけでAmiVoiceとLLMをつなぐ — CSBCで作る音声→要約コンポーネント"
emoji: "🎤"
type: "tech"
topics: ["amivoice", "音声認識", "生成ai", "webcomponents", "claude"]
published: false
---

> この記事は [ZennFes Spring 2026「音声認識AmiVoice APIと生成AIで作る音声体験」](https://zenn.dev/contests/zennfes-spring-2026-amivoice) への投稿です。

## TL;DR

- [`@csbc-dev/ami-voice`](https://www.npmjs.com/package/@csbc-dev/ami-voice)（音声認識）と兄弟パッケージ [`@csbc-dev/ai-agent`](https://www.npmjs.com/package/@csbc-dev/ai-agent)（LLM）を、**バインディングだけ**でつなぎます。
- マイクで話す → 文字起こし → その確定テキストをLLMに渡して要約。アプリ側に書くコードは「**いつLLMに投げるか**」の一行だけ。
- `getUserMedia` / `AudioWorklet` / WebSocketフレーミング / SSEパース / トークン蓄積 / abort / **鍵管理** は、すべて2つのコンポーネントの中。APPKEYもLLMのAPIキーも**サーバから出ません**。
- 動くデモ（鍵ゼロでもオフライン動作）のソースは [`examples/voice-llm-vue/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm-vue)（この記事の例。Vue）にあります。Vanilla版 [`voice-llm/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm)・React版 [`voice-llm-react/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm-react) も同梱です。

## 作るもの

こういう「音声体験」です。

```
🎤 話す（ブラウザ）            🖥 サーバ（秘密はここに常駐）         ☁ 外部
─────────────                ──────────────────────────         ─────────
<ami-voice> ──控制JSON──▶ AmiVoiceCore  ──relay──▶ AmiVoice WSS
   │  └──音声バイナリ───────▶  (APPKEY)
   │
   ▼ transcript（★ここが配線）
<ai-agent>  ──prompt/send──▶ AiCore        ──fetch──▶ Claude など
              ◀──content────  (APIキー)
```

ブラウザに置くのは**ヘッドレスなWeb Componentが2つ**だけ。`<ami-voice>` が話し言葉を文字起こしし、`<ai-agent>` がそれを要約します。両方の「頭脳（Core）」はサーバに常駐し、ブラウザが受け取るのは**状態だけ**（`transcript`、`content` …）です。

## なぜ「配線だけ」で済むのか — CSBCアーキテクチャ

この2つは [CSBC（Core/Shell Bindable Component）](https://github.com/csbc-dev/arch) という共通設計に従った兄弟パッケージです。CSBCの主張はシンプルです。

> フロントエンドの移行コストの本体は、テンプレートではなく **`useEffect` / `onMounted` に貼り付いた非同期ロジック**である。それをフレームワークの外（Web Component側）に追い出す。

各コンポーネントは2層に分かれます。

- **Core（`EventTarget`）= 決定を持つ**。HTTP・WebSocket・リトライ・状態遷移・結果の正規化、そして**秘密鍵**。DOMに触れないのでNode.jsでも動く。
- **Shell（`HTMLElement`）= 委譲できない実行だけ**。DOMライフサイクル、属性マッピング、ブラウザ限定の処理（マイク取得など）。

そして両者は [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol) という極小プロトコルで状態を公開します。`static wcBindable` に「何がバインド可能か」を宣言するだけ。

```js
// <ami-voice> が公開する状態（抜粋）
static wcBindable = {
  protocol: "wc-bindable", version: 1,
  properties: [
    { name: "transcript", event: "ami-voice:transcript-changed" }, // 確定テキスト
    { name: "interim",    event: "ami-voice:interim-changed" },    // 途中経過
    { name: "recognizing", event: "ami-voice:recognizing-changed" },
    /* … */
  ],
  commands: [{ name: "start", async: true }, { name: "stop" }, { name: "reset" }],
};
```

```js
// <ai-agent> が公開する状態（抜粋）
static wcBindable = {
  protocol: "wc-bindable", version: 1,
  properties: [
    { name: "content",   event: "ai-agent:content-changed" },   // ストリーミング応答
    { name: "streaming", event: "ai-agent:streaming-changed" },
    /* … */
  ],
  inputs:   [{ name: "provider" }],
  commands: [{ name: "send", async: true }, { name: "abort" }],
};
```

**出力側に `transcript`、入力側に `prompt`＋`send()` がある。** だから配線が成立します。

## 配線の実物

状態をフロントに映す部分は、フレームワークアダプタに任せます。`@wc-bindable/vue` の `useWcBindable` は「`el.constructor.wcBindable` を読んで各プロパティをVueのリアクティブ状態に同期し、要素 ref でコマンドを呼ぶ」フックです（素のAPIは `@wc-bindable/core` の `bind()` という約20行のフレームワーク非依存関数で、各アダプタはその上に乗っています）。これで両コンポーネントの状態が、**手書きの射影なしで**そのままテンプレートへ流れ込みます。

そして肝心の「音声→LLM」の配線は、`<script setup>` のこれだけです。

```vue
<script setup lang="ts">
import { watch } from "vue";
import { useWcBindable } from "@wc-bindable/vue";

// 各コンポーネントの状態をVueに同期（state→DOM の射影は手書きしない）
const { ref: amiEl, values: ami } = useWcBindable(/* <ami-voice> の初期値 */);
const { ref: aiEl,  values: aiv } = useWcBindable(/* <ai-agent> の初期値 */);

// <ami-voice> の確定テキストを <ai-agent> の prompt に流して send() する
function summarize() {
  if (!ami.transcript.trim()) return;
  aiEl.value!.prompt = ami.transcript;   // プロパティに代入して…
  void aiEl.value!.send();               // …コマンドを呼ぶ。それだけ。
}

// 録音が止まったら（recognizing が true→false）一度だけ呼ぶ ← アプリが書く“唯一の判断”
watch(() => ami.recognizing, (now, prev) => {
  if (prev && !now) summarize();
});
</script>
```

`<ami-voice>` の文字起こしも `<ai-agent>` の応答も、**`bind()` のスイッチや `createElement` を書かずに**、状態がそのままテンプレートに流れ込みます。

```vue
<template>
  <!-- ヘッドレス要素を宣言し、ref と属性で配線する -->
  <ami-voice ref="amiEl" :remote-url="SPEECH_WS" transport="relay" :engine="ENGINE" :codec="CODEC" />
  <ai-agent  ref="aiEl"  :provider="PROVIDER" :model="MODEL" />

  <div class="transcript">{{ ami.transcript }}<span class="interim">{{ ami.interim }}</span></div>
  <div class="answer">{{ aiv.content }}</div>   <!-- ストリーミング応答がそのまま映る -->
</template>
```

消えた配線を数えてみてください。マイク取得、`AudioWorklet`でのダウンサンプリングとPCMフレーミング、AmiVoiceの `s`/`p`/`e` コマンド送出と `S`/`E`/`C`/`U`/`A` イベントのパース、LLMのSSEストリーム解析、トークン蓄積、`AbortController`、そして**2つの秘密鍵の管理** —— アプリ側のコードには一切現れません。すべて2つのCoreの内側です。さらにこのVue版では、状態をDOMへ映す**手書きの射影（`bind()` のスイッチや `createElement`）も `useWcBindable` とテンプレートが肩代わり**するので、アプリに残るのは上の `watch` 一つだけです。

## サーバ：1プロセスに2つのCore（秘密が出ない構造）

なぜ鍵が漏れないのか。両方のCoreを**サーバに置く**からです。1つのNodeプロセスで2つのチャンネルをホストします。

```js
// examples/voice-llm-vue/server.mjs（抜粋。3版とも同じサーバ設計）
const relay = createAmiVoiceRelayServer({ createProvider });   // APPKEY常駐

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const wss = pathname === "/ai-agent" ? aiWss : amiWss;       // パスでルーティング
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// <ami-voice> リレー：制御JSON ＋ 音声バイナリ（サブプロトコルで振り分け）
amiWss.on("connection", (sock, req) => {
  if (sock.protocol) return relay.handleAudioConnection(sock, sock.protocol);    // 音声
  relay.handleControlConnection(new WebSocketServerTransport(sock), { /* … */ });// 制御
});

// <ai-agent> リモート：接続ごとに1つの AiCore（APIキー常駐）
aiWss.on("connection", (sock) => {
  const core = new ServerAiCore();                       // send() で鍵をサーバ注入
  new RemoteShellProxy(core, new WebSocketServerTransport(sock));
});
```

ポイントは2つ。

1. **音声はJSONに乗らない。** `@wc-bindable/remote` のワイヤは `JsonValue` 限定なので、バイナリ音声は別のWebSocketチャンネルで流し、セッションIDで突き合わせます（だから「リレーは二系統」）。
2. **鍵はサーバが上書きする。** `<ai-agent>` はリモートモードでは `api-key` / `base-url` をワイヤに乗せません。サーバ側の `ServerAiCore` が `send()` で鍵・モデル・システムプロンプトを**注入**し、クライアントが指定した値を無視します。これが信頼境界です。

```js
class ServerAiCore extends AiCore {
  set provider(_v) { super.provider = AI_PROVIDER; } // クライアントは差し替え不可
  async send(prompt, options) {
    return super.send(prompt, {
      ...options,
      apiKey: AI_KEY,        // ← サーバ常駐の鍵を注入
      baseUrl: AI_BASE_URL,  // 鍵の宛先も信頼境界に固定（クライアント値は使わない）
      model: AI_MODEL,
      system: AI_SYSTEM,
    });
  }
}
```

> ⚠ なお `@wc-bindable/remote` は**セキュリティ境界ではありません**。本番ではrelayハンドラの手前でpeerを認証してください（デモは誰でも受け付けてオフライン動作します）。

## ハマりどころ：兄弟パッケージは `@wc-bindable` の世代を揃える

CSBCの兄弟パッケージを**合成する**ときの実地ノウハウです。リモートのワイヤ実装は `@wc-bindable/remote` が提供するので、両パッケージが**同じメジャー世代**を向いている必要があります。世代がズレると、`<ami-voice>` のリレーと `<ai-agent>` のリモートを同じ `RemoteShellProxy` で束ねたときに噛み合いません。

実際、初期の `@csbc-dev/ai-agent@0.1.0` は `@wc-bindable/* ^0.4` を向いていて、`@csbc-dev/ami-voice`（`^0.8`）とズレていました。当時はnpm aliasで両世代を入れ、チャンネルごとに使い分ける必要がありました。**`@csbc-dev/ai-agent@0.2.0` で `^0.8` に揃った**ので、今は単一の `@wc-bindable/remote` で両チャンネルをまかなえます。

```jsonc
// package.json（Vue版）— 0.2.0 以降は単一バージョンでOK
"dependencies": {
  "@csbc-dev/ami-voice": "^0.1.0",
  "@csbc-dev/ai-agent": "^0.2.0",
  "@wc-bindable/core": "^0.8.0",
  "@wc-bindable/remote": "^0.8.0",
  "@wc-bindable/vue": "^0.8.0",   // ← フロントのバインドアダプタ（React版なら @wc-bindable/react）
  "vue": "^3.5.0"
}
```

```js
// 両チャンネルが同じ transport / proxy を共有
import { WebSocketServerTransport, RemoteShellProxy } from "@wc-bindable/remote";
```

> 教訓：CSBCパッケージを混ぜるときは、まず `npm ls @wc-bindable/remote` で**重複した別バージョンが無い**ことを確認しましょう。

もう一点。`@csbc-dev/ai-agent` のメインバレルは `<ai-agent>`（`extends HTMLElement`）を即時定義するため、Nodeでそのまま `import` すると `HTMLElement is not defined` で落ちます（`/server` バレルはまだ無いので 0.2.0 でも同じ）。使うのはDOMフリーな `AiCore` だけなので、最小shimを置いてから動的importします。

```js
globalThis.HTMLElement ??= class {};
const { AiCore } = await import("@csbc-dev/ai-agent");
```

これさえ越えれば、あとは素直につながります。実際、サーバを起動して `<ai-agent>` チャンネルを叩くと、オフラインのフェイクLLMから要約がストリーミングで返り、`<ami-voice>` の制御チャンネルも初期状態を同期してくる —— というE2Eのスモークテストが通ることを確認済みです。

## 動かす

```bash
git clone https://github.com/csbc-dev/ami-voice
cd ami-voice/examples/voice-llm-vue
npm install
npm run server     # 別ターミナルで npm run dev
```

**鍵を一切設定しなくても完全オフラインで動きます。** サーバはフェイクのAmiVoice上流とOpenAI互換のフェイクLLM（SSE）を内蔵しているので、マイクで話してStopすると、ダミーの要約がストリーミングで返ります。重要なのは、フェイクなのは**遠い端点だけ**で、Core・リモートプロキシ・ワイヤ・`bind()` はすべて本物が動いている点です（`@csbc-dev/ami-voice` の既存テスト群と同じ流儀）。

本物につなぐときは `.env` に鍵を入れて再起動するだけ。

```bash
# AmiVoice：無料トライアル＋クーポンは https://acp.amivoice.com/
AMIVOICE_APPKEY=...
# 生成AI：おすすめは Anthropic Claude
AI_PROVIDER=anthropic
AI_MODEL=claude-haiku-4-5      # 速くて安い。要約用途に十分。リッチにするなら claude-sonnet-4-6
AI_API_KEY=sk-ant-...
```

> 💡 ZennFesのトライアルクーポン `Na5bkyRHoi` で、5月・6月それぞれ月10時間ぶんのAmiVoice APIが無償で使えます。

## 結局、アプリが書くのは「いつ投げるか」だけ

CSBCで非同期配線を全部追い出すと、最後に**1つの判断**だけが残ります。「**いつ** `transcript` を `prompt` に流すか」です。これはアプリ固有のポリシーなので、Coreに押し込むべきではない —— ここが「Coreは決定を、Shellは委譲できない実行を、アプリはポリシーを」という境界のきれいな実例になっています。

選択肢はいくつもあります。

| 発火タイミング | 体験 | 向き |
|---|---|---|
| **Stopで全文を要約**（本デモ） | 話し終えてから1回 | 議事録・メモの要約 |
| 確定セグメント（`A`）ごと | 1文ごとに逐次処理 | 翻訳・相槌・リアルタイム整形 |
| `interim` を含めて随時 | 最速だが揺れる＆コスト高 | 補完候補のプレビュー等 |

このデモは「Stopで議事録を要約」を既定にしていますが、変えたいのは `summarize()` を**いつ呼ぶか**の一行だけです。音声認識のコマンド送出やLLMのストリーム処理には一切触れません。これがCSBCの「配線だけ」の到達点です。

## まとめ

- AmiVoiceの音声認識と生成AIの連携は、CSBCの兄弟パッケージを使うと**バインディングの配線だけ**で組めます。
- 2つのCoreをサーバに置くことで、**APPKEYもLLMのAPIキーもブラウザに出ません**。
- 実地のコツは「兄弟パッケージで **`@wc-bindable` のメジャー世代を揃える**（`ai-agent@0.2.0` で `0.8` に統一）」と「`AiCore` 取り込みのための `HTMLElement` shim」。
- フレームワークはVanilla / Vue / React いずれでも本質は同じ（`bind()` か各アダプタに置き換わるだけ）。リポジトリには3版とも同梱しています（[`voice-llm/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm) / [`voice-llm-vue/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm-vue) / [`voice-llm-react/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm-react)）。この記事のスニペットは **Vue版**です。

ソース一式：[`examples/voice-llm-vue/`](https://github.com/csbc-dev/ami-voice/tree/main/examples/voice-llm-vue)

---

*この記事のデモはオフライン・オンラインとも動作確認済みです（`npm run build` / 型チェック / 両チャンネルのE2Eスモーク / 本物のAmiVoice APPKEYでの実走）。*
