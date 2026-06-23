// ─────────────────────────────────────────────────────────────────────────────
// 配線だけで「音声 → LLM」。
//
// <ami-voice> が話し言葉を文字起こしし、<ai-agent> がそれを要約する。両 Core は
// サーバ常駐で、APPKEY も LLM の API キーもこのブラウザには来ない。ここに書くのは
// 「いつ transcript を prompt に流して send() するか」という1つのポリシーだけ。
//
// 消えた配線: getUserMedia / AudioWorklet / WSS フレーミング / SSE パース /
// トークン蓄積 / abort / 鍵管理。すべて2つの Core の中。
// ─────────────────────────────────────────────────────────────────────────────
import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import { bind } from "@wc-bindable/core";
import {
  SPEECH_WS, LLM_WS, ENGINE, REALTIME_CODEC, LLM_PROVIDER, LLM_MODEL, LEVEL_METER_GAIN,
} from "./config";
import type { AmiVoiceElement, AiAgentElement, AiUsage } from "./ami-voice";
import "./style.css";

// Register <ami-voice> (relay mode — APPKEY stays on the server) and <ai-agent>
// (remote mode — the LLM key stays on the server). Both bootstraps run BEFORE we
// create the elements, so the tags upgrade straight into their remote modes.
bootstrapAmiVoice();
bootstrapAi({
  remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: LLM_WS },
});

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  // Fail loud if the HTML and this file drift apart (e.g. an id was renamed),
  // instead of a confusing "cannot read appendChild of null" later.
  if (!el) throw new Error(`#${id} not found in index.html`);
  return el as T;
};
function errMsg(e: unknown): string {
  if (!e) return "";
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e) {
    const o = e as { message?: string; body?: string; statusText?: string; status?: number };
    // Avoid the "[object Object]" trap: if none of the known fields are present,
    // fall back to a fixed label rather than String(o).
    return String(o.message || o.body || o.statusText || (o.status ? `HTTP ${o.status}` : "") || "不明なエラー");
  }
  return String(e);
}

// ── Create the two headless elements from config ────────────────────────────────
const ami = document.createElement("ami-voice") as AmiVoiceElement;
ami.setAttribute("remote-url", SPEECH_WS);
ami.setAttribute("transport", "relay");
ami.setAttribute("engine", ENGINE);
ami.setAttribute("codec", REALTIME_CODEC);
$("ami-host").appendChild(ami);

const aiAgent = document.createElement("ai-agent") as AiAgentElement;
aiAgent.setAttribute("provider", LLM_PROVIDER);
aiAgent.setAttribute("model", LLM_MODEL);
// No api-key / base-url: in remote mode the server owns the credential and
// <ai-agent> drops those from the wire payload.
$("ai-host").appendChild(aiAgent);

// ── Speech state → DOM (bind reads ami.constructor.wcBindable) ──────────────────
const transcriptEl = $("transcript");
const interimEl = $("interim");
const levelEl = $("level");
const dotEl = $("dot");
const statusLabel = $("status-label");
const toggleBtn = $<HTMLButtonElement>("toggle");
const rtError = $("rt-error");

let transcript = "";
let recognizing = false;
let connected = false;
let loading = false;
let prevRecognizing = false;

function renderSpeechStatus() {
  toggleBtn.textContent = recognizing ? "■ Stop" : "🎤 Start";
  toggleBtn.classList.toggle("rec", recognizing);
  // During the handshake (`loading`) the session is neither started nor stopped
  // yet, so disable the button — this also blocks a double-tap from firing a
  // second start()/stop() before the first resolves.
  toggleBtn.disabled = loading;
  dotEl.classList.toggle("on", recognizing);
  statusLabel.textContent =
    loading ? "connecting…" : recognizing ? "recognizing" : connected ? "connected" : "idle";
}

bind(ami, (name, value) => {
  switch (name) {
    case "transcript": transcript = String(value ?? ""); transcriptEl.textContent = transcript; break;
    case "interim": interimEl.textContent = value ? " " + value : ""; break;
    case "level": levelEl.style.width = Math.min(100, Math.round((Number(value) || 0) * LEVEL_METER_GAIN)) + "%"; break;
    case "recognizing":
      recognizing = Boolean(value);
      renderSpeechStatus();
      // ★ THE WIRING ★ — when recognition stops with text, hand it to the LLM.
      // Relies on a Core ordering guarantee: stop() does `await session.stop()`
      // (graceful `e`-flush that waits for the final `A`, which updates
      // `transcript`) BEFORE flipping recognizing→false (AmiVoiceCore.stop /
      // _teardownSession). In this relay/remote setup that Core runs server-side,
      // so we depend on the @wc-bindable/remote control channel preserving the
      // Core's emission order over its single WS — transcript-changed arrives
      // before recognizing-changed:false. The empty-guard in summarize()
      // (`if (!transcript.trim()) return`) absorbs any edge case where it doesn't.
      if (prevRecognizing && !recognizing) onSpeechStopped();
      prevRecognizing = recognizing;
      break;
    case "connected": connected = Boolean(value); renderSpeechStatus(); break;
    case "loading": loading = Boolean(value); renderSpeechStatus(); break;
    case "error": rtError.hidden = !value; rtError.textContent = errMsg(value); break;
  }
});

toggleBtn.addEventListener("click", () => (recognizing ? void ami.stop() : void ami.start()));
$("reset").addEventListener("click", () => ami.reset());

// ── LLM state → DOM ─────────────────────────────────────────────────────────────
const answerEl = $("answer");
const answerEmpty = $("answer-empty");
const aiDot = $("ai-dot");
const aiStatus = $("ai-status");
const usageEl = $("usage");
const aiError = $("ai-error");

bind(aiAgent, (name, value) => {
  switch (name) {
    case "content":
      answerEl.textContent = String(value ?? "");
      answerEmpty.hidden = Boolean(value);
      break;
    case "streaming":
    case "loading": {
      // Two events feed one "busy" indicator, so we read BOTH current values off
      // the element rather than the single `value` for whichever event fired —
      // either one changing must recompute against the other.
      const busy = aiAgent.loading || aiAgent.streaming;
      aiDot.classList.toggle("on", busy);
      aiStatus.textContent = aiAgent.streaming ? "streaming" : aiAgent.loading ? "thinking" : "idle";
      break;
    }
    case "usage": {
      const u = value as AiUsage | null;
      usageEl.hidden = !u;
      if (u) usageEl.textContent = `prompt ${u.promptTokens} · completion ${u.completionTokens} · total ${u.totalTokens}`;
      break;
    }
    case "error": aiError.hidden = !value; aiError.textContent = errMsg(value); break;
  }
});

// ── The one policy decision: WHEN to forward transcript → prompt → send ──────────
function summarize() {
  if (!transcript.trim()) return;
  // Hide the previous run's token-usage line immediately. The Core also resets
  // usage→null at send() start, so the bind() handler above would clear it anyway
  // — but that null has to make the remote round-trip first, so we hide it here
  // up front to avoid flashing stale counts during the handshake (redundant but
  // harmless). content/error are overwritten by their own bind() events.
  usageEl.hidden = true;
  // That's it. prompt is a plain property; send() runs the server-side Core.
  aiAgent.prompt = transcript;
  // A failed send() normally also publishes `ai-agent:error` (handled in the bind
  // above), so this catch is a belt-and-suspenders fallback: if a rejection ever
  // arrives without an accompanying error event, still surface it instead of
  // failing silently.
  void aiAgent.send().catch((e) => {
    if (aiError.hidden) { aiError.hidden = false; aiError.textContent = errMsg(e); }
  });
}

function onSpeechStopped() {
  if (($("auto") as HTMLInputElement).checked) summarize();
}

$("summarize").addEventListener("click", summarize);

// ── Mode banner ─────────────────────────────────────────────────────────────────
$("ai-mode").textContent =
  `LLM: ${LLM_PROVIDER}/${LLM_MODEL}（サーバが固定。鍵なしで起動した場合はオフラインのダミー応答になります）`;
