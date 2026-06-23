import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { bind } from "@wc-bindable/core";
import { SERVER_HTTP, SERVER_WS, ENGINE, REALTIME_CODEC } from "./config";
import "./style.css";

interface RecognitionSegment { text: string; confidence: number }
interface AmiVoiceElement extends HTMLElement {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}

// Register <ami-voice>. The APPKEY stays on the shared server (relay mode).
bootstrapAmiVoice();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function errMsg(e: unknown): string {
  if (!e) return "";
  if (typeof e === "object" && e && "message" in e) return String((e as { message?: string }).message ?? e);
  return String(e);
}

// ── Realtime: create the element from config and bind its reactive state ─────
const ami = document.createElement("ami-voice") as AmiVoiceElement;
ami.setAttribute("remote-url", SERVER_WS);
ami.setAttribute("transport", "relay");
ami.setAttribute("engine", ENGINE);
ami.setAttribute("codec", REALTIME_CODEC);
$("ami-host").appendChild(ami);

const transcriptEl = $("transcript");
const interimEl = $("interim");
const segmentsEl = $<HTMLUListElement>("segments");
const levelEl = $("level");
const dotEl = $("dot");
const statusLabel = $("status-label");
const toggleBtn = $<HTMLButtonElement>("toggle");
const rtError = $("rt-error");

let recognizing = false;
let connected = false;

function renderStatus() {
  toggleBtn.textContent = recognizing ? "■ Stop" : "🎤 Start";
  toggleBtn.classList.toggle("rec", recognizing);
  dotEl.classList.toggle("on", recognizing);
  statusLabel.textContent = recognizing ? "recognizing" : connected ? "connected" : "idle";
}

// bind() reads ami.constructor.wcBindable, delivers each property's initial value,
// then calls back on every change. One callback drives the whole UI.
bind(ami, (name, value) => {
  switch (name) {
    case "transcript": transcriptEl.textContent = String(value ?? ""); break;
    case "interim": interimEl.textContent = value ? " " + value : ""; break;
    case "level": levelEl.style.width = Math.min(100, Math.round(Number(value) * 140)) + "%"; break;
    case "recognizing": recognizing = Boolean(value); renderStatus(); break;
    case "connected": connected = Boolean(value); renderStatus(); break;
    case "segments": {
      const segs = (Array.isArray(value) ? value : []) as RecognitionSegment[];
      segmentsEl.replaceChildren(...segs.map((s) => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = s.text;
        const conf = document.createElement("span");
        conf.className = "seg-conf";
        conf.textContent = `conf ${s.confidence.toFixed(2)}`;
        li.append(text, conf);
        return li;
      }));
      break;
    }
    case "error": {
      rtError.hidden = !value;
      rtError.textContent = errMsg(value);
      break;
    }
  }
});

toggleBtn.addEventListener("click", () => {
  if (recognizing) void ami.stop();
  else void ami.start();
});
$("reset").addEventListener("click", () => ami.reset());

// ── File recognition: plain fetch to the shared server (Case B1) ─────────────
const fileInput = $<HTMLInputElement>("file");
const recognizeBtn = $<HTMLButtonElement>("recognize");
const fileOut = $("file-out");
const fileTranscript = $("file-transcript");
const fileSegments = $<HTMLUListElement>("file-segments");
const fileOffline = $("file-offline");
const fileError = $("file-error");

fileInput.addEventListener("change", () => { recognizeBtn.disabled = !fileInput.files?.length; });

recognizeBtn.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  recognizeBtn.disabled = true;
  recognizeBtn.textContent = "Recognizing…";
  fileError.hidden = true;
  fileOut.hidden = true;
  try {
    const res = await fetch(
      `${SERVER_HTTP}/api/recognize?engine=${encodeURIComponent(ENGINE)}&codec=16K`,
      { method: "POST", body: file },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    fileTranscript.textContent = data.transcript;
    fileSegments.replaceChildren(...(data.segments as RecognitionSegment[]).map((s) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = s.text;
      const conf = document.createElement("span");
      conf.className = "seg-conf";
      conf.textContent = `conf ${s.confidence.toFixed(2)}`;
      li.append(text, conf);
      return li;
    }));
    fileOffline.hidden = !data.offline;
    fileOut.hidden = false;
  } catch (e) {
    fileError.textContent = errMsg(e);
    fileError.hidden = false;
  } finally {
    recognizeBtn.disabled = false;
    recognizeBtn.textContent = "Recognize";
  }
});
