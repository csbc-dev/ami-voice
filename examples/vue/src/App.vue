<script setup lang="ts">
import { computed, ref } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { AmiVoiceElement, AmiVoiceValues, RecognitionSegment } from "./types";
import { SERVER_HTTP, SERVER_WS, ENGINE, REALTIME_CODEC } from "./config";

function errMsg(e: unknown): string {
  if (!e) return "";
  if (typeof e === "object" && e && "message" in e) return String((e as { message?: string }).message ?? e);
  return String(e);
}

// ── Realtime: bind <ami-voice> state into Vue via @wc-bindable/vue ───────────
const { ref: amiEl, values: ami } = useWcBindable<AmiVoiceElement, AmiVoiceValues>({
  recognizing: false, connected: false, transcript: "", interim: "",
  segments: [], confidence: 0, level: 0, loading: false, error: null, mode: "remote",
});

const levelPct = computed(() => Math.min(100, Math.round(ami.level * 140)));
const statusLabel = computed(() =>
  ami.recognizing ? "recognizing" : ami.connected ? "connected" : "idle");

function toggle() {
  if (ami.recognizing) amiEl.value?.stop();
  else amiEl.value?.start();
}

// ── File recognition: plain fetch to the shared server (Case B1) ─────────────
const file = ref<File | null>(null);
const fileLoading = ref(false);
const fileResult = ref<{ transcript: string; segments: RecognitionSegment[]; offline?: boolean } | null>(null);
const fileError = ref("");

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

async function recognizeFile() {
  if (!file.value) return;
  fileLoading.value = true; fileError.value = ""; fileResult.value = null;
  try {
    const res = await fetch(
      `${SERVER_HTTP}/api/recognize?engine=${encodeURIComponent(ENGINE)}&codec=16K`,
      { method: "POST", body: file.value },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    fileResult.value = data;
  } catch (e) {
    fileError.value = errMsg(e);
  } finally {
    fileLoading.value = false;
  }
}
</script>

<template>
  <main>
    <h1>Vue + <code>&lt;ami-voice&gt;</code></h1>
    <p class="lead">
      Speech recognition for the AmiVoice cloud API. The APPKEY stays on the shared
      server; the browser binds the <code>&lt;ami-voice&gt;</code> element's reactive state
      through <code>@wc-bindable/vue</code>.
    </p>
    <div class="badges">
      <span class="badge">Vue 3</span>
      <span class="badge wc">&lt;ami-voice&gt;</span>
      <span class="badge">@wc-bindable/vue</span>
    </div>

    <!-- ── Realtime ──────────────────────────────────────────────────────── -->
    <section>
      <h2>Realtime (relay)</h2>

      <!-- Headless element. transport="relay" routes audio through the server,
           so the APPKEY never reaches the browser. -->
      <ami-voice
        ref="amiEl"
        :remote-url="SERVER_WS"
        transport="relay"
        :engine="ENGINE"
        :codec="REALTIME_CODEC"
      />

      <div class="row">
        <button :class="{ rec: ami.recognizing }" @click="toggle">
          {{ ami.recognizing ? "■ Stop" : "🎤 Start" }}
        </button>
        <button class="ghost" @click="amiEl?.reset()">Reset</button>
        <span class="status">
          <span class="dot" :class="{ on: ami.recognizing }" />
          {{ statusLabel }}
        </span>
      </div>

      <div class="meter"><span :style="{ width: levelPct + '%' }" /></div>

      <div class="transcript">
        {{ ami.transcript }}<span v-if="ami.interim" class="interim"> {{ ami.interim }}</span>
      </div>

      <ul v-if="ami.segments.length" class="segments">
        <li v-for="(s, i) in ami.segments" :key="i">
          <span>{{ s.text }}</span>
          <span class="seg-conf">conf {{ s.confidence.toFixed(2) }}</span>
        </li>
      </ul>

      <div v-if="ami.error" class="error">{{ errMsg(ami.error) }}</div>
      <p class="muted">Allow the microphone when prompted. Chrome recommended.</p>
    </section>

    <!-- ── File recognition ─────────────────────────────────────────────── -->
    <section>
      <h2>File recognition</h2>
      <div class="row">
        <input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac" @change="onFile" />
        <button :disabled="!file || fileLoading" @click="recognizeFile">
          {{ fileLoading ? "Recognizing…" : "Recognize" }}
        </button>
      </div>

      <template v-if="fileResult">
        <div class="transcript">{{ fileResult.transcript }}</div>
        <ul class="segments">
          <li v-for="(s, i) in fileResult.segments" :key="i">
            <span>{{ s.text }}</span>
            <span class="seg-conf">conf {{ s.confidence.toFixed(2) }}</span>
          </li>
        </ul>
        <p v-if="fileResult.offline" class="muted">
          Offline fake result — set <code>AMIVOICE_APPKEY</code> on the server for real recognition.
        </p>
      </template>
      <div v-if="fileError" class="error">{{ fileError }}</div>
      <p class="muted">Posts the file to <code>{{ SERVER_HTTP }}/api/recognize</code> (server-side recognition).</p>
    </section>
  </main>
</template>
