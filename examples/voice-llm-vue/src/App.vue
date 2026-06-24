<script setup lang="ts">
// ─────────────────────────────────────────────────────────────────────────────
// 配線だけで「音声 → LLM」— Vue 版。
//
// バニラ版 (examples/voice-llm) との違いは、state→DOM の射影を手書きせず
// @wc-bindable/vue の useWcBindable に任せる点。<ami-voice> / <ai-agent> の
// reactive な状態がそのままテンプレートに流れ込むので、アプリ側に残るのは
// 「いつ transcript を prompt に流して send() するか」という watch ひとつだけ。
//
// 消えた配線: getUserMedia / AudioWorklet / WSS フレーミング / SSE パース /
// トークン蓄積 / abort / 鍵管理 — すべて2つの Core の中。さらにバニラ版にあった
// bind() の switch・createElement・DOM 参照も、フレームワークが宣言的に肩代わり。
// ─────────────────────────────────────────────────────────────────────────────
import { computed, ref, watch } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type {
  AmiVoiceElement, AmiVoiceValues, AiAgentElement, AiAgentValues,
} from "./types";
import {
  SPEECH_WS, ENGINE, REALTIME_CODEC, LLM_PROVIDER, LLM_MODEL, LEVEL_METER_GAIN,
} from "./config";

function errMsg(e: unknown): string {
  if (!e) return "";
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const o = e as { message?: string; body?: string; statusText?: string; status?: number };
    return String(o.message || o.body || o.statusText || (o.status ? `HTTP ${o.status}` : "") || "不明なエラー");
  }
  return String(e);
}

// ── <ami-voice> の reactive 状態を Vue に同期（bind() の switch を置換） ──────────
const { ref: amiEl, values: ami } = useWcBindable<AmiVoiceElement, AmiVoiceValues>({
  recognizing: false, connected: false, transcript: "", interim: "",
  level: 0, loading: false, error: null, mode: "remote",
});

// ── <ai-agent> の reactive 状態を Vue に同期 ────────────────────────────────────
const { ref: aiEl, values: aiv } = useWcBindable<AiAgentElement, AiAgentValues>({
  content: "", loading: false, streaming: false, usage: null, error: null,
});

const auto = ref(true); // 「Stop で自動要約」

const levelPct = computed(() => Math.min(100, Math.round(ami.level * LEVEL_METER_GAIN)));
const speechStatus = computed(() =>
  ami.loading ? "connecting…" : ami.recognizing ? "recognizing" : ami.connected ? "connected" : "idle");
const aiStatus = computed(() => (aiv.streaming ? "streaming" : aiv.loading ? "thinking" : "idle"));
const aiBusy = computed(() => aiv.loading || aiv.streaming);

function toggle() {
  if (ami.recognizing) void amiEl.value?.stop();
  else void amiEl.value?.start();
}

// ── THE WIRING ── 確定テキストを <ai-agent> の prompt に流して send() するだけ。
function summarize() {
  if (!ami.transcript.trim()) return; // 空ガード（後述の順序エッジを吸収）
  const el = aiEl.value;
  if (!el) return;
  el.prompt = ami.transcript;
  // 失敗は通常 aiv.error にも出るが、error イベントを伴わない reject も拾えるよう catch。
  void el.send().catch(() => {/* surfaced via aiv.error in the template */});
}

// 唯一のポリシー判断：認識が止まったら（Stop）一度だけ要約する（auto オン時）。
// recognizing→false が届く時点で確定 transcript は反映済み、という Core の発火順に
// 乗っている。順序が崩れる環境では確定が一拍遅れうるが、summarize() の空ガードが
// 空送信だけは確実に弾く。
watch(
  () => ami.recognizing,
  (now, prev) => { if (prev && !now && auto.value) summarize(); },
);
</script>

<template>
  <main>
    <h1>音声 → LLM を<em>配線だけ</em>で <small>(Vue)</small></h1>
    <p class="lead">
      <code>&lt;ami-voice&gt;</code> が話し言葉を文字起こしし、その確定テキストを
      <code>&lt;ai-agent&gt;</code> の <code>prompt</code> に流して要約させます。
      APPKEY も LLM の API キーもサーバに常駐し、ブラウザには一切出ません。
    </p>
    <div class="badges">
      <span class="badge wc">&lt;ami-voice&gt;</span>
      <span class="badge">+</span>
      <span class="badge wc">&lt;ai-agent&gt;</span>
      <span class="badge">@wc-bindable/vue</span>
    </div>

    <!-- Headless 要素。UI は持たない。ここで宣言し、ref と属性バインドだけで配線する。
         transport="relay" で音声はサーバ経由（APPKEY はブラウザに来ない）。 -->
    <ami-voice
      ref="amiEl"
      :remote-url="SPEECH_WS"
      transport="relay"
      :engine="ENGINE"
      :codec="REALTIME_CODEC"
    />
    <!-- remote モード（LLM キーはサーバ常駐）。provider/model はサーバが固定で握り潰す。 -->
    <ai-agent ref="aiEl" :provider="LLM_PROVIDER" :model="LLM_MODEL" />

    <!-- ── 1. 話す（CSBC Case C：マイクはブラウザ、APPKEY はサーバ） ── -->
    <section>
      <h2>1. 話す（リアルタイム文字起こし）</h2>

      <div class="row">
        <button :class="{ rec: ami.recognizing }" :disabled="ami.loading" @click="toggle">
          {{ ami.recognizing ? "■ Stop" : "🎤 Start" }}
        </button>
        <button class="ghost" @click="amiEl?.reset()">Reset</button>
        <span class="status">
          <span class="dot" :class="{ on: ami.recognizing }" />
          {{ speechStatus }}
        </span>
      </div>

      <div class="meter"><span :style="{ width: levelPct + '%' }" /></div>

      <div class="transcript">
        {{ ami.transcript }}<span v-if="ami.interim" class="interim"> {{ ami.interim }}</span>
      </div>

      <div v-if="ami.error" class="error">{{ errMsg(ami.error) }}</div>
      <p class="muted">
        マイクを許可してください（Chrome 推奨）。「Stop で自動要約」がオンのとき、
        <strong>Stop</strong> で自動的に LLM に渡します。
      </p>
    </section>

    <!-- ── 2. 要約させる（CSBC Case B1：LLM キーはサーバ） ── -->
    <section>
      <h2>2. 要約させる（LLM）</h2>

      <div class="row">
        <label class="auto"><input type="checkbox" v-model="auto" /> Stop で自動要約</label>
        <button @click="summarize">この文字起こしを要約</button>
        <span class="status">
          <span class="dot" :class="{ on: aiBusy }" />
          {{ aiStatus }}
        </span>
      </div>

      <div class="answer">
        <div class="answer-body">{{ aiv.content }}</div>
        <div v-if="!aiv.content" class="muted">
          まだ要約はありません。話して Stop するか、ボタンを押してください。
        </div>
      </div>

      <div v-if="aiv.usage" class="usage">
        prompt {{ aiv.usage.promptTokens }} · completion {{ aiv.usage.completionTokens }}
        · total {{ aiv.usage.totalTokens }}
      </div>
      <div v-if="aiv.error" class="error">{{ errMsg(aiv.error) }}</div>
      <p class="muted">
        LLM: {{ LLM_PROVIDER }}/{{ LLM_MODEL }}
        （サーバが固定。鍵なしで起動した場合はオフラインのダミー応答になります）
      </p>
    </section>

    <p class="footer muted">
      消えた配線：getUserMedia / AudioWorklet / WSS フレーミング / SSE パース /
      トークン蓄積 / abort / 鍵管理、さらに bind() の switch・createElement・DOM 参照。
      残ったのは「いつ LLM に投げるか」の <code>watch</code> 一つだけ。
    </p>
  </main>
</template>
