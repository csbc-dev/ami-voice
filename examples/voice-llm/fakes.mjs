// Offline fakes — let the whole demo run with NO credentials.
//
// Two fake upstreams, one per Core:
//   • fake AmiVoice realtime WSS  → so <ami-voice transport="relay"> gets canned
//     interim (`U`) / final (`A`) results as audio frames arrive.
//   • fake OpenAI-compatible LLM  → an HTTP endpoint that streams an OpenAI-style
//     SSE response, so the server-side AiCore runs its REAL provider code path
//     (OpenAiProvider.buildRequest / parseStreamChunk) against a fake target.
//
// This mirrors how examples/shared/fakeAmiVoice.mjs works: the Core, the relay,
// the remote proxy, the wire and bind() are all real — only the far endpoint is
// faked. Set AMIVOICE_APPKEY / AI_API_KEY to point at the real services instead.
//
// NOTE: wsSocketFactory + startFakeRealtime below are an INTENTIONAL fork of
// examples/shared/fakeAmiVoice.mjs (kept here so this example is self-contained on
// published packages). The only change is PHRASES — swapped to a meeting-style
// script so the LLM summary has something worth summarizing offline.
import { WebSocketServer } from "ws";
import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Fake AmiVoice realtime
// ─────────────────────────────────────────────────────────────────────────────

/** Adapt a Node `ws` client into the provider's RealtimeSocket shape. */
export function wsSocketFactory(url) {
  const ws = new WebSocket(url);
  const sock = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data, isBinary) => { if (!isBinary) sock.onmessage?.(data.toString()); });
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

// A short, meeting-like canned transcript so the LLM summary has something worth
// summarizing offline. (With a real APPKEY this is replaced by real recognition.)
const PHRASES = [
  "本日の議題は新機能のリリース日についてです。",
  "結論として、来週の金曜日を目標にします。",
  "担当は田中さん、テストは木曜までに完了させます。",
];

/**
 * Minimal in-process fake AmiVoice realtime endpoint. Acks `s`/`p`/`e` and, as
 * audio frames stream in, emits an interim `U` then a fixed `A` final per phrase.
 * Returns the `ws://…` URL to hand the provider as its realtime endpoint.
 */
export function startFakeRealtime() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    let frames = 0;
    let idx = 0;
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        frames++;
        if (frames % 8 === 0 && idx < PHRASES.length) {
          const phrase = PHRASES[idx++];
          const t = frames * 20;
          // Build the JSON payload as an object and JSON.stringify it (rather than
          // hand-concatenating a JSON string), then prefix the AmiVoice event
          // command (`U ` interim / `A ` final). Safe even if a phrase ever
          // contains a quote or backslash.
          const uPayload = { text: phrase, results: [{ tokens: [{ written: phrase }] }] };
          const aPayload = { text: phrase, results: [{
            text: phrase, confidence: 0.95, starttime: t, endtime: t + 200,
            tokens: [{ written: phrase, spoken: phrase, confidence: 0.95, starttime: 0, endtime: 200 }],
          }] };
          sock.send(`U ${JSON.stringify(uPayload)}`);
          sock.send(`A ${JSON.stringify(aPayload)}`);
        }
        return;
      }
      const cmd = data.toString()[0];
      if (cmd === "s") sock.send("s");
      else if (cmd === "p") sock.send("p");
      else if (cmd === "e") {
        // On end-of-audio, flush ALL remaining phrases as finals — "Stop and the
        // rest is committed" — so a short utterance still yields the full meeting
        // script for the offline summary, instead of dropping un-emitted phrases.
        while (idx < PHRASES.length) {
          const phrase = PHRASES[idx++];
          const aPayload = { text: phrase, results: [{
            text: phrase, confidence: 0.9, starttime: 0, endtime: 200, tokens: [],
          }] };
          sock.send(`A ${JSON.stringify(aPayload)}`);
        }
        sock.send("e");
      }
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve(`ws://127.0.0.1:${wss.address().port}/`)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake OpenAI-compatible LLM (SSE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle a fake `POST /fake-llm/v1/chat/completions`. Reads the OpenAI-style
 * request body, extracts the last user message, and streams back a templated
 * "summary" as OpenAI SSE chunks so AiCore's streaming path lights up for real.
 */
export async function handleFakeLlm(req, res) {
  const body = await readJson(req);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const transcript = textOf(lastUser?.content).trim();

  const reply = transcript
    ? [
        "【オフラインのダミー要約】",
        "・話された内容: " + truncate(transcript, 60),
        "・本番では AI_API_KEY を設定すると Claude などが実際に要約します。",
        "ToDo: .env に AMIVOICE_APPKEY と AI_API_KEY を入れて再起動する。",
      ].join("\n")
    : "（文字起こしが空でした。マイクで話してから Stop してください。）";

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Stream piece-by-piece as `chat.completion.chunk` deltas, with a small delay
  // so the streaming UI visibly fills in (the real providers stream for real).
  const pieces = reply.match(/[^\n]+\n?|\n/g) ?? [reply];
  for (const piece of pieces) {
    res.write(sse({ choices: [{ index: 0, delta: { content: piece } }] }));
    await delay(70);
  }
  // Trailing usage-only chunk + finish_reason, then the [DONE] sentinel.
  res.write(sse({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: transcript.length, completion_tokens: reply.length, total_tokens: transcript.length + reply.length },
  }));
  res.write("data: [DONE]\n\n");
  res.end();
}

function sse(obj) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", ...obj })}\n\n`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  return "";
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
