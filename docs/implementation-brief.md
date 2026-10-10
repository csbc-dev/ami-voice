# 実装用ブリーフ — `@csbc-dev/ami-voice` 残作業（Phase 1 仕上げ → 2 → 3）

このブリーフは、散在する根拠（[ADR](adr/) = *なぜ* / [SPEC.md](../SPEC.md) = *なに* / [implementation-plan.md](implementation-plan.md) = *いつ・どの順* / [implementation-notes.md](implementation-notes.md) = 未決の *どう*）を、**残作業1本ぶん**の実装指示に畳み込んだもの。新しい決定はしていない（既存決定の追跡可能な再構成）。各項目は網羅を優先したため概要寄り。矛盾が出たら **ADR / SPEC が正**。

> **対象スコープ**: 残作業すべて。Phase 0–3（足場＋リレー＋直結＋ハードニング）は完了済み（build clean / unit 154 + integration 3 + Playwright 2 = green、2026-06-23 時点で再現確認済み）。

---

## 0. 現状の真実（着手前提）

> **注**: 本 §0 は relay/direct/Phase 3 完了前の旧版。確定状態は [CLAUDE.md「Implementation status」](../CLAUDE.md) / [SPEC.md §23](../SPEC.md) / [implementation-plan.md](implementation-plan.md) が正本（矛盾時はそちら）。実態は relay + direct 両トランスポート＋Phase 3 ハードニングまで実装・テスト緑。

| 既に実装済み（テスト緑） | 場所 |
|---|---|
| バインダブル面・Core 状態機械・target injection | [src/core/AmiVoiceCore.ts](../src/core/AmiVoiceCore.ts) |
| `s`/`p`/`e` ビルダ + `S/E/C/U/A/G` パーサ | [src/protocol/wnnProtocol.ts](../src/protocol/wnnProtocol.ts) |
| PCM ダウンサンプル / `LSB16K` フレーミング / level | [src/audio/pcmEncoder.ts](../src/audio/pcmEncoder.ts) |
| Shell（local/relay/direct・二チャネル配線・back-pressure・level throttle） | [src/components/AmiVoice.ts](../src/components/AmiVoice.ts) |
| Provider リアルタイム WSS ループ（socket 注入可）・`recognizeFile`（async v2）・`issueOneTimeAppKey` | [src/providers/AmiVoiceProvider.ts](../src/providers/AmiVoiceProvider.ts) |
| エラーコード正規化（閉じた union + retryable） | [src/errorCodes.ts](../src/errorCodes.ts) |
| リレーサーバ補助（control + 音声 + セッション表） | [src/createAmiVoiceServer.ts](../src/createAmiVoiceServer.ts) |
| Node フルスタック e2e・例サーバ・ユーザ README | [tests/integration/relay.e2e.test.ts](../tests/integration/relay.e2e.test.ts) / [examples/relayServer.mjs](../examples/relayServer.mjs) / README.md |

**まだ無い**: ① 実 AmiVoice スモークラン（有料 APPKEY、`AMIVOICE_APPKEY` gated）、② ユーザ手動リリース（version bump + `npm publish`）。①②以外（実ブラウザ Playwright ハーネス、直結モード `transport="direct"`、Phase 3 ハードニング）は実装・テスト緑。自動再接続と telephony コーデックは将来拡張として保留。

---

## 1. 最終的に採用する仕様（What — SPEC が正本）

実装が満たすべき確定仕様。すべて [SPEC.md](../SPEC.md) と [ADR](adr/) に既出。**変えない**。

1. **コンポーネントは1つの権威タグ `<ami-voice>`（class `WcsAmiVoice`）**。input/command はすべてここ。子タグは追加しても projection 専用（SPEC §5, [ADR 0004](adr/0004-bindable-surface.md)）。
2. **バインダブル面（SPEC §7）は公開契約で不変**。プロパティ `recognizing / connected / transcript / interim / segments / speakers / confidence / loading / error / level / mode`、input 8種（`engine / codec / profileId / profileWords / keepFillerToken / resultUpdatedInterval / segmenterProperties / noLog`）、command `start(async) / stop(async) / abort / reset`。イベント名は `ami-voice:<name>-changed`、ただし `error` だけ無サフィックスの signal `ami-voice:error`。
3. **`transcript`（確定・`A`由来）と `interim`（仮説・`U`由来）は別プロパティで併合禁止。`confidence` は確定のみ（`U` から更新禁止）**（SPEC §7.1/§8）。
4. **APPKEY はサーバ常駐**。`AMIVOICE_APPKEY` から読み、wcBindable input / 属性 / クライアントバンドル / ログのいずれにも出さない（SPEC §14, [ADR 0002](adr/0002-appkey-residency-and-remote-first.md)）。
5. **リアルタイムは二チャネルリレーが既定**: JSON control（`@wc-bindable/remote`）＋ 別 binary WebSocket（音声、browser→server のみ）。音声を control に base64 で載せない。セッション id で相関し、token は `Sec-WebSocket-Protocol` で運ぶ（SPEC §11, [ADR 0003](adr/0003-realtime-audio-transport.md)）。
6. **`transport` は deployment 設定**（`transport="relay" | "direct"` 属性 / config）。**wcBindable の property/input/command にしない**。認識面はモード間でバイト同一（SPEC §11.4, [ADR 0006](adr/0006-transport-baseline-after-one-time-appkey.md) rule 1）。
7. **コーデックは Core 決定**。既定 `LSB16K`。Shell は Core が宣言した形式にエンコードするだけで独自選択しない。エンコードできない `codec` は黙って `LSB16K` に落とさず**拒否**。ADPCM 非対応（SPEC §13, [ADR 0005](adr/0005-audio-capture-and-codec-ownership.md)）。
8. **エラーは reject せず `error` に publish して `loading` を落とす**。AmiVoice 1文字 result code を閉じた `AmiVoiceErrorCode` union に正規化し raw message を保持。client-error 部分集合（`>`,`o`,`+`,`-`,`%`）は非リトライ（SPEC §17, Q7/D2、実装済 [errorCodes.ts](../src/errorCodes.ts)）。
9. **`stop()` は graceful**（capture 停止 → `e` 送信 → `e` ack まで `A`/`U` を消費 → settle、~5s フォールバック、timeout でも error にせず累積保持）。**`abort()` は即時**、DOM disconnect は `abort()` 相当（SPEC §18, Q4/D1）。
10. **File mode は Core command `recognizeFile`**（async v2 enqueue→poll→正規化）。ブラウザデータプレーン無し（SPEC §19）。

---

## 2. 採用する設計方針（How — 残作業の進め方）

### 全体原則（[implementation-plan.md](implementation-plan.md) より）
- **リレー先行**。リレーが既定で Core 権威が最強。直結は phase 2 のオプトイン。**リレー経路は直結追加で一切壊さない**（ADR 0006 rule 3：正規化・エラーマップを直結と共有、並行コードパスを作らない）。
- **決定先行**。開いた決定ゲート（特に 2.1）をロックするまで該当タスクに着手しない。
- **各フェーズは runnable + tested で締める**。半配線で止めない。
- **`ws` は実行時依存にしない**。server helper は注入されたソケットを受ける（[createAmiVoiceServer.ts](../src/createAmiVoiceServer.ts) の `AudioSocketLike` / `ServerTransport`）。`ws` は example/harness の devDep のみ。

### Phase 1 仕上げ — 実ブラウザ Playwright ハーネス（plan 1.3 のブラウザ部分）
- Chromium の **fake audio device**（`--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`）で `getUserMedia`→`AudioWorklet`→ダウンサンプル→PCM フレーミング→binary 音声チャネルの**データプレーンと相関**を、unit では届かない実 DOM で検証する。
- 接続先は**ローカル fake AmiVoice WSS**（[tests/support/fakeAmiVoice.ts](../tests/support/fakeAmiVoice.ts) を再利用）＋ 例サーバ相当のリレー。実 APPKEY 不要を既定 CI 経路にする。
- `<ami-voice transport="relay" remote-url=…>` を実ページに置き、start→（fake が `U`→`A`/`e`）→`interim` 後に `transcript` 反映、を assert。

### Phase 2 — ブラウザ直結モード `transport="direct"`（[ADR 0006](adr/0006-transport-baseline-after-one-time-appkey.md)、オプトイン）
単一チャネル `O(connections)`。永続 APPKEY はサーバから出ず、ブラウザは30秒・IP制限のワンタイム APPKEY で **AmiVoice WSS に自分で繋ぐ**。
- **2.1（決定ゲート・未ロック）**: ブラウザがワンタイム APPKEY＋承認済み `s`-params を要求する操作の形。
  - **推奨**: 専用 command を足さず **`start()` に畳み込む**（direct のとき `start()` の `invoke` 戻り値を「session token（relay）」から「`{ appKey, sParams, endpoint }`（direct）」に切り替える）。理由: command 面を増やすと ADR 0006 rule 1（認識面の同一性）に抵触する。`start()` の戻り値は bound state ではなく Shell が内部消費する `invoke` 結果なので、モード間で形を変えてよい。
  - **2.1 で確定すべき下位点**: 戻り値の JSON 形・direct 時に server 側 Core が `openRealtimeSession` を呼ばない分岐の置き場所（Core に `transport` を渡すか、server helper 層で start を差し替えるか）。**着手前にこの一点をロック**。
- **2.2 server mint endpoint**: server helper を拡張し、選んだ操作経由で `issueOneTimeAppKey({ ipa?, epi? })`（[provider 既存](../src/providers/AmiVoiceProvider.ts) L238）＋承認済み `s`-params を返す。判定できる範囲で `ipa` をピア IP に縛る。
- **2.3 Shell direct path**: `start()` direct 分岐でトークン取得→**ブラウザ用 `RealtimeSocket`**（[wnnProtocol.ts](../src/protocol/wnnProtocol.ts) と [pcmEncoder.ts](../src/audio/pcmEncoder.ts) を再利用）で AmiVoice WSS を直接開く→承認済み `s` 送信→イベントを**クライアント側でパース**→音声を直接ストリーム。**server 音声チャネルは使わない**。
- **2.4 transport selector 配線**: `transport` config option ＋ `transport` 属性 ＋ モード解決（local/remote と直交）。**wcBindable input/property にしない**。
- **2.5 `ipa` graceful degradation**: ピア IP 不明（NAT/proxy）なら `ipa` 無し＋短い `epi` に縮退（Q12）。
- 直結時の Core *決定* 権威は**advisory**（ブラウザが `s` を送る）。s-params のサーバ強制が必要なら**新 ADR**で（ADR 0006 rule 5）。

### Phase 3 — ハードニング & リリース
- **3.1 上流再接続（Q3 / v1）**: AmiVoice WSS が中途切断したら `error` ＋ `connected=false` を立て、明示 `start()` 再実行を要求。**確定済み `transcript` を絶対に捨てない**。自動再接続は将来拡張。SPEC §10 に明記。
- **3.2 diarization / 多言語（Q6・gated）**: 既定は token の `label`/`language` のまま据え置き。専用子 projection タグは要件が出たら（product input 待ち）。
- **3.3 コーデック拡張（Q9・gated）**: telephony が要件化したら `8K`＋`MULAW`/`ALAW` を [pcmEncoder.ts](../src/audio/pcmEncoder.ts) に追加。Shell は未対応 `codec` を**拒否**。
- **3.4 デプロイ時セキュリティプロファイル**: auth-before-shell・per-command 認可・rate limit・音声 token を `Sec-WebSocket-Protocol`・`JsonValue` リソース上限を、ドキュメント＋例で示す（SPEC §14, [ADR 0002](adr/0002-appkey-residency-and-remote-first.md)）。例サーバの `TODO(auth)` プレースホルダを実装ガイドに昇格。
- **3.5 構造化ロギング**: server helper に注入可能な `Logger`（connection open/close、拒否フレーム、emit したエラー）。
- **3.6 カバレッジ & 公開準備**: カバレッジゲート、README/SPEC のバージョン参照確定、**`CLAUDE.md`「Implementation status」を実態に整合**、version bump、[release skill](../.claude/skills/release/SKILL.md) で公開（`@wc-bindable/*` が `^0.10.0`・`file:` 依存なしを確認）。`npm publish` は**ユーザが手動**で行う（Claude は実行しない）。

---

## 3. 採用しない方針（明示的に却下）

| 却下するもの | 理由 / 根拠 |
|---|---|
| **直結を唯一の baseline にする**（ADR 0003 を supersede） | Core 決定権威を全員ぶん侵食し、安全経路をオプトイン化する。直結は**オプトインのみ**（[ADR 0006](adr/0006-transport-baseline-after-one-time-appkey.md) Alt B）。 |
| **`transport` を wcBindable input にする** | transport は deployment/trust 決定でアプリ状態ではない。wire に載せるとクライアントがサーバ topology を切替可能になる（ADR 0006 Alt C / rule 1）。 |
| **音声を JSON control チャネルに base64 で載せる** | `@wc-bindable/remote` は `JsonValue` のみ。二チャネル必須（SPEC §11.2, [ADR 0003](adr/0003-realtime-audio-transport.md)、メモリ [[ami-voice-remote-wire-is-json-only]]）。 |
| **永続 APPKEY をブラウザに出す / 短命credential 無しの browser-direct** | 資格情報リーク。直結でも30秒・IP制限のワンタイム token のみ（SPEC §14.5, ADR 0006 rule 2）。 |
| **`transcript`/`interim` 併合・`confidence` を `U` から更新** | UI が確定/仮説を描き分けられなくなる（SPEC §7.1/§8, ADR 0004）。 |
| **`ws` を runtime 依存に追加** | server helper は注入ソケット方式。`ws` は example/harness の devDep のみ（plan Risks）。 |
| **自動再接続で確定 `transcript` を黙って捨てる / 上流を黙って再接続** | v1 は明示再開（Q3 lean (a)、ADR 0006 rule 4）。 |
| **ADPCM ストリーミング・on-device 認識・TTS/双方向音声・diarization UI（token `label` 超え）** | v1 非ゴール（SPEC §22）。 |
| **リレーで音声をサーバ迂回（v1）** | 非ゴール（SPEC §22）。サーバコストは `O(audio volume)` を許容し README に明記（SPEC §20）。 |

---

## 4. 実装対象ファイル

### Phase 1 仕上げ（新規中心）
- `playwright.config.ts`（新規）— Chromium fake-audio フラグ、`test:e2e` 相当。
- `tests/e2e/relay.browser.spec.ts`（新規）— 実ブラウザ `<ami-voice>` シナリオ。
- `tests/fixtures/`（新規）— テストページ HTML / バンドル、fake AmiVoice + リレー起動。
- `package.json` — `test:e2e` script、`@playwright/test` を devDep に追加。

### Phase 2 直結モード（新規＋限定改修）
- `src/components/realtimeSocket.ts`（新規）— ブラウザ用 `RealtimeSocket`（`wnnProtocol` + `pcmEncoder` 再利用、events をクライアントでパース）。
- `src/components/AmiVoice.ts`（改修）— `start()`/`stop()`/`abort()` に direct 分岐、`transport` 属性、direct 用 mic→直接 WSS 配線。
- `src/createAmiVoiceServer.ts`（改修）— direct 用 mint 経路（`issueOneTimeAppKey` + 承認 `s`-params を `start()` 結果で返す）、`transport` オプション。
- `src/config.ts` / `src/components/remoteConnection.ts`（改修）— `transport` 解決・direct 用 URL/トークン取り回し。
- `src/index.ts` / `src/server.ts`（改修）— 新規 export（`RealtimeSocket` 型・direct 補助）を両バレルに反映。
- 対応する `__tests__/*.test.ts`（新規）＋ `tests/e2e` direct シナリオ（2.6）。

### Phase 3 ハードニング（限定改修）
- `src/core/AmiVoiceCore.ts` / `src/providers/AmiVoiceProvider.ts`（改修）— 上流切断時の `error`+`connected=false`（3.1）。
- `src/audio/pcmEncoder.ts`（改修・gated）— `8K`/`MULAW`/`ALAW`（3.3）。
- `src/createAmiVoiceServer.ts`（改修）— 注入 `Logger`（3.5）。
- `SPEC.md`（§10 再接続）/ `README.md` / `CLAUDE.md`（古い note 更新）/ `examples/relayServer.mjs`（auth 実装ガイド）/ `docs/` — ドキュメント整合（3.4/3.6）。
- 直結を baseline 化する等、ADR を覆す変更が出たら**新 ADR**（`docs/adr/000N-*.md`）。

---

## 5. 変更してよい範囲

- **新規ファイル追加**（上記 §4 の新規群）。直結・Playwright・ロギングは原則「config/helper の裏に新規追加」で入れる。
- **`AmiVoice.ts` Shell**: direct 分岐・`transport` 解決・mic 配線の追加。**ただし既存の relay/local 分岐の挙動は不変に保つ**。
- **`createAmiVoiceServer.ts`**: mint 経路・`transport` オプション・`Logger` 注入の追加。**既存 `handleControlConnection`/`handleAudioConnection`/セッション表のリレー挙動は不変**。
- **`AmiVoiceProvider.ts` / `AmiVoiceCore.ts`**: 再接続ポリシー（3.1）と direct 時の start 分岐（2.1 ロック後）。
- **`pcmEncoder.ts`**: コーデック追加（gated、既存 `LSB16K` パスは不変）。
- **`SPEC.md` §10**（再接続を確定文言化）、**`CLAUDE.md`**（古い Release note 更新）、**README / examples / docs**。
- **テスト・Playwright 設定・`package.json` の scripts/devDeps**（`@playwright/test`、`ws` は devDep 維持）。
- **新 ADR の追加**（既存 ADR を覆す決定をする場合のみ。番号は次の空き、既存は renumber/削除しない）。

---

## 6. 変更してはいけない範囲（不変条件）

破ると公開契約 / セキュリティ / エコシステム互換が壊れる。

1. **バインダブル面の名前と規約**: property/input/command 名、`protocol:"wc-bindable"`/`version:1`、イベント命名 `ami-voice:<name>-changed`、`error` の無サフィックス signal。全 binder が依存（SPEC §7/§21, CLAUDE.md 規約）。**直結追加でもバイト同一に保つ**。
2. **`transcript`/`interim` 分離・`confidence` 確定限定**（SPEC §7.1/§8）。
3. **APPKEY 規律**: ブラウザ・wcBindable input・属性・バンドル・ログに出さない。`AMIVOICE_APPKEY` 由来のみ（SPEC §14, ADR 0002）。
4. **`transport` を wcBindable surface に昇格させない**（ADR 0006 rule 1）。
5. **二チャネル相関を信頼境界として維持**: 音声チャネルは認証済みセッションに束縛、token は `Sec-WebSocket-Protocol`、別ピアのセッション id に音声を付けられない（SPEC §11.3/§14, 既存 e2e のリジェクト検証を壊さない）。
6. **既存リレー経路の振る舞い**: control proxy ↔ Core ↔ provider WSS ループ ↔ binary 音声 → `feedAudio` のパスと、[relay.e2e.test.ts](../tests/integration/relay.e2e.test.ts) の assert（`interim`→`transcript` 伝播、unknown-token 拒否）を退行させない。
7. **テスト済み純モジュールの契約**: `wnnProtocol` / `pcmEncoder` / `errorCodes` / `flowControl` の公開シグネチャと既存テスト。拡張は additive に。
8. **ロックされた ADR 決定（0001–0006）**: CSBC 分類・remote-first・二チャネル・単一権威タグ・codec=Core・relay 既定。**新 ADR 無しに relitigate しない**（implementation-notes §C）。
9. **`ws` を package runtime 依存に入れない**。
10. **バレルの環境境界**: `src/index.ts`（browser）には `HTMLElement` 系を、`src/server.ts`（Node-safe）には `HTMLElement` を持ち込まない。新 export は適切な側へ。

---

## 7. 実装手順（順序）

クリティカルパス: **Phase 1 ハーネス → 2.1 決定 → 2.2 mint → 2.3 direct Shell → 2.6 direct tests → Phase 3（大半独立、3.6 最後）**。

### Step A — Phase 1 仕上げ（ハーネス）
1. `playwright.config.ts` ＋ Chromium fake-audio フラグ、`package.json` に `test:e2e` と `@playwright/test`。
2. テストページ／fixtures と、fake AmiVoice＋リレー起動配線（`tests/support` 再利用）。
3. `tests/e2e/relay.browser.spec.ts`: start→`interim`→`transcript`、mic/AudioWorklet 経路が実ブラウザで通ることを assert。
4. README の quickstart 手順がこの経路と一致することを確認。**→ Phase 1 exit。**

### Step B — Phase 2 直結（2.1 ロック後）
5. **2.1 を決める**（推奨: `start()` 畳み込み）。下位点（戻り値 JSON 形・direct 分岐の置き場所）も同時にロック。
6. **2.2**: server helper に mint 経路（`issueOneTimeAppKey` + 承認 `s`-params）を実装、`ipa` をピアに束縛。
7. **2.3**: `src/components/realtimeSocket.ts`（`wnnProtocol`+`pcmEncoder` 再利用）→ Shell `start()` direct 分岐で AmiVoice WSS 直結・`s` 送信・client パース・直接ストリーム。
8. **2.4 / 2.5**: `transport` selector 配線（属性/config、wcBindable 化禁止）、`ipa` 不明時の縮退。
9. **2.6**: unit（token フロー・direct socket）＋ Playwright direct シナリオ。**relay 経路の全テストが緑のままを確認。→ Phase 2 exit。**

### Step C — Phase 3 ハードニング & リリース
10. **3.1** 上流再接続（`error`+`connected=false`、確定 transcript 保持）→ SPEC §10 文言化。
11. **3.4 / 3.5** セキュリティプロファイル文書＋例の auth 実装、注入 `Logger`。
12. **3.3 / 3.2**（gated）: 要件が出たらコーデック拡張・diarization。出なければ「非対応を明記」で締める。
13. **3.6** カバレッジゲート、`CLAUDE.md` の古い note 更新、README/SPEC バージョン整合、version bump、release skill。`npm publish` はユーザ手動。

---

## 8. テスト方針

- **既定 CI は無資格情報**。実 AmiVoice は paid APPKEY が要るので env var ゲートの別経路にし、**fake AmiVoice WSS（[tests/support/fakeAmiVoice.ts](../tests/support/fakeAmiVoice.ts)）を既定**にする（plan Risks / Q14）。
- **層別**:
  - *unit*（`__tests__`, happy-dom, `npm test`）: 純ロジック（protocol/encoder/errorCodes/flowControl）＋ Core 状態機械＋契約。direct の token フロー・`realtimeSocket` パースもここに足す。
  - *integration*（`tests/integration`, `test:integration`）: 実 `ws` ソケットで client proxy ↔ relay ↔ fake。direct も Node 段で token→直結→`interim`/`transcript` を足す。
  - *e2e*（`tests/e2e`, Playwright・新規）: 実 Chromium ＋ fake audio device で mic/AudioWorklet/DOM の**データプレーンと相関**。relay と direct の両シナリオ。
- **退行ガード**: 既存の unit/integration スイートは常時緑を維持（正確な件数は CLAUDE.md「Implementation status」が正）。リレー経路と二チャネル相関のリジェクト検証を壊さない（§6-5/6）。
- **契約テスト不変**: [amiVoiceWcBindableContract.test.ts](../__tests__/amiVoiceWcBindableContract.test.ts) が name/event 規約を固定。直結追加でこの assert を変えないこと（= 面が同一の証拠）。
- **AudioWorklet クロスブラウザ**: 最低 Chromium で通す。Safari/Firefox 差は見つけ次第ノート化（plan Risks）。
- **AmiVoice エラーコード**: client-error 部分集合の非リトライ判定（[errorCodes.test.ts](../__tests__/errorCodes.test.ts)）を direct 側でも共有（並行コードパス禁止、ADR 0006 rule 3）。

---

## 9. 完了条件

### Phase 1 exit
- `playwright` で実ブラウザの `<ami-voice transport="relay">` が fake AmiVoice WSS 相手に start→発話（fake フレーム）→**ライブ transcript** を描画。
- `npm run example` 起動 → ページで start → fake/実機で transcript が出る。README がデプロイを説明済み。

### Phase 2 exit
- `transport="direct"` が**音声サーバ迂回**でエンドツーエンド認識し、**永続 APPKEY がサーバから出ず**（30秒・IP制限 token のみ）、**リレー経路は不変**（全テスト緑）。
- 認識バインダブル面が relay と direct で**バイト同一**（契約テストが両モードで通る）。

### Phase 3 exit / リリース可
- 再接続（Q3）・必要なコーデック（Q9）・diarization 方針（Q6）が決定済み（gated は「非対応を明記」でも可）。
- デプロイ時セキュリティプロファイルと注入ロギングがドキュメント＋例で提示済み。
- カバレッジゲート通過。`CLAUDE.md`/`SPEC.md`/README のバージョン・状態記述が実態と整合（特に `CLAUDE.md`「Implementation status」が実態どおり）。
- マニフェストが publishable（`@wc-bindable/*` が `^0.10.0` semver、`file:` 依存なし）。`npm run build` クリーン。**`npm publish` はユーザが手動実行**（[release skill](../.claude/skills/release/SKILL.md)）。

---

## 付録: 着手前にロックすべき決定ゲート

| ゲート | 質問 / 根拠 | 状態 |
|---|---|---|
| **2.1 前** | direct token 要求操作の形（**推奨: `start()` 畳み込み**） | **未ロック — 最初に決める** |
| 2.5 前 | `ipa` 戦略（IP 不明時に縮退） | lean 記録済（Q12） |
| 3.1 前 | 上流再接続（v1=明示再開・確定 transcript 保持） | lean 記録済（Q3） |
| 3.2 前 | diarization を v1 surface に出すか | **product input 待ち**（Q6） |
| 3.3 前 | 8K/telephony コーデック要否 | **telephony 要件待ち**（Q9） |
