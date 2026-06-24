// ─────────────────────────────────────────────────────────────────────────────
// 配線だけで「音声 → LLM」— React 版。
//
// バニラ版 (examples/voice-llm) との違いは、state→DOM の射影を手書きせず
// @wc-bindable/react の useWcBindable に任せる点。<ami-voice> / <ai-agent> の
// reactive な状態がそのまま JSX に流れ込むので、アプリ側に残るのは「いつ
// transcript を prompt に流して send() するか」という useEffect ひとつだけ。
//
// 消えた配線: getUserMedia / AudioWorklet / WSS フレーミング / SSE パース /
// トークン蓄積 / abort / 鍵管理 — すべて2つの Core の中。さらにバニラ版にあった
// bind() の switch・createElement・DOM 参照も、フレームワークが宣言的に肩代わり。
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type {
  AmiVoiceElement, AmiVoiceValues, AiAgentElement, AiAgentValues,
} from "./ami-voice";
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

export function App() {
  // ── <ami-voice> の reactive 状態を React に同期（bind() の switch を置換） ──────
  const [amiRefCb, ami] = useWcBindable<AmiVoiceElement, AmiVoiceValues>({
    recognizing: false, connected: false, transcript: "", interim: "",
    level: 0, loading: false, error: null, mode: "remote",
  });
  // useWcBindable は callback ref を返す。要素の命令的メソッド (start/stop/reset)
  // を呼ぶため、自前の elRef にも同じ node を流し込む。
  const amiEl = useRef<AmiVoiceElement | null>(null);
  const amiRef = useCallback((node: AmiVoiceElement | null) => {
    amiEl.current = node;
    amiRefCb(node);
  }, [amiRefCb]);

  // ── <ai-agent> の reactive 状態を React に同期 ──────────────────────────────────
  const [aiRefCb, aiv] = useWcBindable<AiAgentElement, AiAgentValues>({
    content: "", loading: false, streaming: false, usage: null, error: null,
  });
  const aiEl = useRef<AiAgentElement | null>(null);
  const aiRef = useCallback((node: AiAgentElement | null) => {
    aiEl.current = node;
    aiRefCb(node);
  }, [aiRefCb]);

  const [auto, setAuto] = useState(true); // 「Stop で自動要約」
  const autoRef = useRef(auto);
  autoRef.current = auto;

  // ── THE WIRING ── 確定テキストを <ami-voice> 要素から直接読み、<ai-agent> に渡す。
  const summarize = useCallback(() => {
    const amiNode = amiEl.current;
    const aiNode = aiEl.current;
    if (!amiNode || !aiNode) return;
    const text = (amiNode.transcript ?? "").trim();
    if (!text) return; // 空ガード（後述の順序エッジを吸収）
    aiNode.prompt = amiNode.transcript;
    // 失敗は通常 aiv.error にも出るが、error イベントを伴わない reject も握りつぶさない。
    void aiNode.send().catch(() => {/* surfaced via aiv.error in JSX */});
  }, []);

  // 唯一のポリシー判断：認識が止まったら（true→false）一度だけ要約する（auto オン時）。
  // recognizing→false が届く時点で確定 transcript は反映済み、という Core の発火順に
  // 乗っている。順序が崩れる環境では確定が一拍遅れうるが、空ガードが空送信を弾く。
  const prevRecognizing = useRef(false);
  useEffect(() => {
    if (prevRecognizing.current && !ami.recognizing && autoRef.current) summarize();
    prevRecognizing.current = ami.recognizing;
  }, [ami.recognizing, summarize]);

  const levelPct = Math.min(100, Math.round(ami.level * LEVEL_METER_GAIN));
  const speechStatus = ami.loading
    ? "connecting…" : ami.recognizing ? "recognizing" : ami.connected ? "connected" : "idle";
  const aiStatus = aiv.streaming ? "streaming" : aiv.loading ? "thinking" : "idle";
  const aiBusy = aiv.loading || aiv.streaming;

  return (
    <main>
      <h1>音声 → LLM を<em>配線だけ</em>で <small>(React)</small></h1>
      <p className="lead">
        <code>&lt;ami-voice&gt;</code> が話し言葉を文字起こしし、その確定テキストを
        <code>&lt;ai-agent&gt;</code> の <code>prompt</code> に流して要約させます。
        APPKEY も LLM の API キーもサーバに常駐し、ブラウザには一切出ません。
      </p>
      <div className="badges">
        <span className="badge wc">&lt;ami-voice&gt;</span>
        <span className="badge">+</span>
        <span className="badge wc">&lt;ai-agent&gt;</span>
        <span className="badge">@wc-bindable/react</span>
      </div>

      {/* Headless 要素。UI は持たない。ここで宣言し、ref と属性で配線する。
          transport="relay" で音声はサーバ経由（APPKEY はブラウザに来ない）。 */}
      <ami-voice
        ref={amiRef}
        remote-url={SPEECH_WS}
        transport="relay"
        engine={ENGINE}
        codec={REALTIME_CODEC}
      />
      {/* remote モード（LLM キーはサーバ常駐）。provider/model はサーバが固定で握り潰す。 */}
      <ai-agent ref={aiRef} provider={LLM_PROVIDER} model={LLM_MODEL} />

      {/* ── 1. 話す（CSBC Case C：マイクはブラウザ、APPKEY はサーバ） ── */}
      <section>
        <h2>1. 話す（リアルタイム文字起こし）</h2>

        <div className="row">
          <button
            className={ami.recognizing ? "rec" : ""}
            disabled={ami.loading}
            onClick={() => (ami.recognizing ? amiEl.current?.stop() : amiEl.current?.start())}
          >
            {ami.recognizing ? "■ Stop" : "🎤 Start"}
          </button>
          <button className="ghost" onClick={() => amiEl.current?.reset()}>Reset</button>
          <span className="status">
            <span className={`dot${ami.recognizing ? " on" : ""}`} />
            {speechStatus}
          </span>
        </div>

        <div className="meter"><span style={{ width: `${levelPct}%` }} /></div>

        <div className="transcript">
          {ami.transcript}
          {ami.interim && <span className="interim"> {ami.interim}</span>}
        </div>

        {ami.error && <div className="error">{errMsg(ami.error)}</div>}
        <p className="muted">
          マイクを許可してください（Chrome 推奨）。「Stop で自動要約」がオンのとき、
          <strong>Stop</strong> で自動的に LLM に渡します。
        </p>
      </section>

      {/* ── 2. 要約させる（CSBC Case B1：LLM キーはサーバ） ── */}
      <section>
        <h2>2. 要約させる（LLM）</h2>

        <div className="row">
          <label className="auto">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Stop で自動要約
          </label>
          <button onClick={summarize}>この文字起こしを要約</button>
          <span className="status">
            <span className={`dot${aiBusy ? " on" : ""}`} />
            {aiStatus}
          </span>
        </div>

        <div className="answer">
          <div className="answer-body">{aiv.content}</div>
          {!aiv.content && (
            <div className="muted">まだ要約はありません。話して Stop するか、ボタンを押してください。</div>
          )}
        </div>

        {aiv.usage && (
          <div className="usage">
            prompt {aiv.usage.promptTokens} · completion {aiv.usage.completionTokens}
            {" "}· total {aiv.usage.totalTokens}
          </div>
        )}
        {aiv.error && <div className="error">{errMsg(aiv.error)}</div>}
        <p className="muted">
          LLM: {LLM_PROVIDER}/{LLM_MODEL}
          （サーバが固定。鍵なしで起動した場合はオフラインのダミー応答になります）
        </p>
      </section>

      <p className="footer muted">
        消えた配線：getUserMedia / AudioWorklet / WSS フレーミング / SSE パース /
        トークン蓄積 / abort / 鍵管理、さらに bind() の switch・DOM 操作。
        残ったのは「いつ LLM に投げるか」の <code>useEffect</code> 一つだけ。
      </p>
    </main>
  );
}
