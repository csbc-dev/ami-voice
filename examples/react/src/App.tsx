import { useCallback, useRef, useState } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { AmiVoiceElement, AmiVoiceValues, RecognitionSegment } from "./ami-voice";
import { SERVER_HTTP, SERVER_WS, ENGINE, REALTIME_CODEC } from "./config";

function errMsg(e: unknown): string {
  if (!e) return "";
  if (typeof e === "object" && e && "message" in e) return String((e as { message?: string }).message ?? e);
  return String(e);
}

interface FileResult { transcript: string; segments: RecognitionSegment[]; offline?: boolean }

export function App() {
  // ── Realtime: bind <ami-voice> state into React via @wc-bindable/react ──────
  const [amiRef, ami] = useWcBindable<AmiVoiceElement, AmiVoiceValues>({
    recognizing: false, connected: false, transcript: "", interim: "",
    segments: [], confidence: 0, level: 0, loading: false, error: null, mode: "remote",
  });
  const elRef = useRef<AmiVoiceElement | null>(null);
  const ref = useCallback((node: AmiVoiceElement | null) => {
    elRef.current = node;
    amiRef(node);
  }, [amiRef]);

  // ── File recognition: plain fetch to the shared server (Case B1) ────────────
  const [file, setFile] = useState<File | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileResult, setFileResult] = useState<FileResult | null>(null);
  const [fileError, setFileError] = useState<string>("");

  const recognizeFile = useCallback(async () => {
    if (!file) return;
    setFileLoading(true); setFileError(""); setFileResult(null);
    try {
      const res = await fetch(
        `${SERVER_HTTP}/api/recognize?engine=${encodeURIComponent(ENGINE)}&codec=16K`,
        { method: "POST", body: file },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setFileResult(data as FileResult);
    } catch (e) {
      setFileError(errMsg(e));
    } finally {
      setFileLoading(false);
    }
  }, [file]);

  const levelPct = Math.min(100, Math.round(ami.level * 140));

  return (
    <main>
      <h1>React + <code>&lt;ami-voice&gt;</code></h1>
      <p className="lead">
        Speech recognition for the AmiVoice cloud API. The APPKEY stays on the shared
        server; the browser binds the <code>&lt;ami-voice&gt;</code> element's reactive state
        through <code>@wc-bindable/react</code>.
      </p>
      <div className="badges">
        <span className="badge">React 19</span>
        <span className="badge wc">&lt;ami-voice&gt;</span>
        <span className="badge">@wc-bindable/react</span>
      </div>

      {/* ── Realtime ──────────────────────────────────────────────────────── */}
      <section>
        <h2>Realtime (relay)</h2>

        {/* Headless: the element carries no UI. transport="relay" routes audio
            through the server so the APPKEY never reaches the browser. */}
        <ami-voice
          ref={ref}
          remote-url={SERVER_WS}
          transport="relay"
          engine={ENGINE}
          codec={REALTIME_CODEC}
        />

        <div className="row">
          <button
            className={ami.recognizing ? "rec" : ""}
            onClick={() => (ami.recognizing ? elRef.current?.stop() : elRef.current?.start())}
          >
            {ami.recognizing ? "■ Stop" : "🎤 Start"}
          </button>
          <button className="ghost" onClick={() => elRef.current?.reset()}>Reset</button>
          <span className="status">
            <span className={`dot${ami.recognizing ? " on" : ""}`} />
            {ami.recognizing ? "recognizing" : ami.connected ? "connected" : "idle"}
          </span>
        </div>

        <div className="meter"><span style={{ width: `${levelPct}%` }} /></div>

        <div className="transcript">
          {ami.transcript}
          {ami.interim && <span className="interim"> {ami.interim}</span>}
        </div>

        {ami.segments.length > 0 && (
          <ul className="segments">
            {ami.segments.map((s, i) => (
              <li key={i}>
                <span>{s.text}</span>
                <span className="seg-conf">conf {s.confidence.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}

        {ami.error && <div className="error">{errMsg(ami.error)}</div>}
        <p className="muted">Allow the microphone when prompted. Chrome recommended.</p>
      </section>

      {/* ── File recognition ─────────────────────────────────────────────── */}
      <section>
        <h2>File recognition</h2>
        <div className="row">
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button onClick={recognizeFile} disabled={!file || fileLoading}>
            {fileLoading ? "Recognizing…" : "Recognize"}
          </button>
        </div>

        {fileResult && (
          <>
            <div className="transcript">{fileResult.transcript}</div>
            <ul className="segments">
              {fileResult.segments.map((s, i) => (
                <li key={i}>
                  <span>{s.text}</span>
                  <span className="seg-conf">conf {s.confidence.toFixed(2)}</span>
                </li>
              ))}
            </ul>
            {fileResult.offline && (
              <p className="muted">Offline fake result — set <code>AMIVOICE_APPKEY</code> on the server for real recognition.</p>
            )}
          </>
        )}
        {fileError && <div className="error">{fileError}</div>}
        <p className="muted">Posts the file to <code>{SERVER_HTTP}/api/recognize</code> (server-side recognition).</p>
      </section>
    </main>
  );
}
