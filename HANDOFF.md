# Handoff: `dsh-speech-to-text-nemo` — Canary + Parakeet v3 recognizers for DSH voice input

Written 2026-10-12 at the end of a session that started in `D:\source\repos\dsh\dsh-prompt-enhancer`.

> **Status (later on 2026-10-12): implemented as 0.1.0.** The user chose **no `auto` on Canary**
> (decision 1 below) and documented the switching workaround instead. Parakeet's hashes are pinned
> and its language list was checked against the model card. Both models were run end to end. For
> current facts, read README.md and CHANGELOG.md; this file is kept as background.

## 1. Goal

Build a **standalone DSH bundle** that adds local speech recognizers to DeepSeek Harness's official
voice input (`@deepseek-ai/dsh-experimental-voice-input-bundle`), exactly the way the official
`@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` package adds SenseVoice:

- **NVIDIA NeMo Canary 180M Flash** (int8): English, Spanish, German, French; ~198 MB.
- **NVIDIA NeMo Parakeet TDT 0.6B v3** (int8): 25 European languages; ~640 MB.

Constraint from the user: **no fork, no upstream changes.** The `deepseek-harness` repo accepts no
issues or PRs, so everything must go through public extension points.

## 2. Decision: one plugin, named `dsh-speech-to-text-nemo`

One bundle registers **two providers**, `canary-local` and `parakeet-local`. Reasons:

- Both are NeMo models run by the same native runtime (`sherpa-onnx-node`), so they share all
  infrastructure: subprocess worker, pinned/verified downloads, Silero VAD segmentation, progress
  reporting, config validation. Two plugins would duplicate all of that plus a second copy of the
  ~22 MB native runtime.
- The speech registry already supports several providers from one plugin (one `register()` call
  each), and the official UI shows a **separate preparation card per provider**, so users download
  only the model(s) they use.
- Add config switches (`canary.enabled`, `parakeet.enabled`, default both `true`) so a user can hide
  one model without uninstalling.
- Naming follows the official pattern (`speech-to-text-<engine>`). Use the **unscoped** package
  name `dsh-speech-to-text-nemo`; do not use the `@deepseek-ai` scope or the `experimental` prefix.
- Run **one worker subprocess per provider** (same worker script, different model config), started
  on first use and released after idle, so only the model in use occupies memory.

## 3. What we verified about DSH (installed version 0.2.0-rc.2)

DSH install root (packages resolve from here; also read their `README.md` and `lib/types/*.d.ts`):
`C:\Users\pchovan\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\`

### The extension point is public
- Host service `speechToText` ("Registry shared by all transcription consumers") exposes
  `register(provider: SpeechProvider): () => Promise<void>` plus `listProviders`, `snapshot`,
  `follow`, `configure`, `prepare`, `cancelPreparation`, `resolve`, `transcribe`.
- Provider contract: `@deepseek-ai/dsh-experimental-speech-to-text/lib/types/types.d.ts`.
  Key types: `SpeechProvider { info, preparation?, transcribe(input, signal) }`,
  `SpeechProviderInfo { id, name, location: 'host-local'|'cloud', languages, setupEstimate?, downloadSources? }`,
  `SpeechPreparation { snapshot, subscribe, prepare(options?), cancel }`,
  `SpeechPreparationState` (phases unprepared/ready/standby/cancelled/downloading/checking/loading/
  waking/cancelling/failed, with optional `steps` of kind check/model/vad/verify/load),
  `SpeechInput { audio: Uint8Array /* canonical 16 kHz mono PCM16 WAV */, language }`,
  `Transcript { text, audioSeconds, inferenceSeconds }` (empty text = no speech).
- `audio` is validated canonical **16 kHz mono PCM16 WAV**; `./wave` helper in the speech-to-text
  package does that validation.

### Reference implementation to copy: the SenseVoice provider
`@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`:
- `package.json`: deps `sherpa-onnx-node@1.13.8`, `zod`, `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-timeout`; peerDeps `@deepseek-ai/cordis ~4.0.4`,
  `@deepseek-ai/dsh-experimental-speech-to-text 0.2.0-rc.2`, `@deepseek-ai/dsh-subprocess 0.2.0-rc.2`.
  Exports `./worker`. Ships `runtime/assets.json` (pinned assets).
- `lib/index.js` (956 lines):
  - lines 913–954: `name = "experimental-speech-to-text-sensevoice"`,
    `inject = ["speechToText", "subprocess"]`, `apply(ctx, config)` validates absolute paths,
    builds a worker, then inside `ctx.effect(...)` calls `ctx.speechToText.register({ info, preparation: worker, transcribe })`,
    calls `worker.inspect()` (check caches, no downloads), and returns a disposer that unregisters and disposes.
  - ~line 549–554: `downloadSources` computed from `modelOrigin`/`modelOrigins` (empty when explicit offline paths).
  - ~line 670: rejects an unadvertised download source.
  - ~line 773: worker started with `this.ctx.subprocess.spawn({...})`.
- `lib/worker.js` (221 lines): config defaults incl. `providerId: "sensevoice-local"`,
  `segmentSeconds: 30`, `vadThreshold: 0.5`; Silero VAD segmentation; language validation
  (`SpeechInputError` = rejected before native inference, worker stays loaded).
- Type files worth reading: `config.d.ts`, `runtime.d.ts` (`inspectRuntime`, `downloadAsset`,
  `prepareRuntime`), `recognizer.d.ts`, `process-server.d.ts`, `model-sources.d.ts`, `download-error.d.ts`.
- README behaviours to mirror: pinned revisions + size + SHA-256 per file; origins
  `https://huggingface.co` and `https://hf-mirror.com` probed with HEAD (3 s), first 2xx tried
  first; network/HTTP/cert/integrity failures fall through to the next source; partial downloads
  restart; verified files reused; activation only inspects caches; bounded queue; idle timeout;
  cancellation kills the worker.

### Composition (how the official bundle wires it)
`@deepseek-ai/dsh-experimental-voice-input-bundle/cordis.patch.yml`:
```yaml
- insert:
    - id: speech-to-text
      name: '@deepseek-ai/dsh-experimental-speech-to-text'
      config:
        defaultProvider: sensevoice-local
    - id: speech-to-text-sensevoice
      name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
      config:
        dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')
    - id: api-speech-to-text
      name: '@deepseek-ai/dsh-experimental-api-speech-to-text'
    - id: ui-voice-input
      name: '@deepseek-ai/dsh-experimental-client-ui-voice-input'
```
Our bundle inserts one row, e.g. `id: speech-to-text-nemo`, `name: dsh-speech-to-text-nemo`,
`config.dataRoot: !!js dshHomePath('speech-to-text', 'nemo')`. **Verify** that `dshHomePath` is
available to third-party bundles (load the `cordis-composition-reference` skill); otherwise compute
the path in the plugin from the Host context.

### The official UI already supports extra providers
`@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js`, `VoicePreparation`, lines 5649–5719:
- Provider `<select>` lists `catalog.providers`; language `<select>` lists the **selected
  provider's** `languages`; one `PreparationCard` per provider (download source choice, progress,
  steps, errors). So no UI code is needed.
- **Gap 1 (switching):** the provider select calls `configure({ providerId })` only.
  `speech-to-text/lib/index.js` lines 121–137 then validate the *currently saved* language against
  the new provider and throw `Speech provider <id> does not support language: <lang>` (shown in the
  UI as an alert). Example: SenseVoice + `auto` → Canary fails; Canary + `es` → SenseVoice fails.
- **Gap 2 (labels):** language names are hard-coded only for auto/zh/en/yue/ja/ko
  (`languageNames[language] ?? language`), so other codes display raw (`es`, `de`, ...). Cosmetic;
  no clean fix from outside.

### Native runtime facts (`sherpa-onnx-node` 1.13.8 + `sherpa-onnx-win-x64`, ~22 MB)
- `types.js` documents `OfflineCanaryModelConfig { encoder, decoder, srcLang, tgtLang, usePnc }`
  and `OfflineTransducerModelConfig { encoder, decoder, joiner }` plus `modelConfig.modelType`.
- `non-streaming-asr.js`: `OfflineRecognizer` has `createStream`, `setConfig(config)` (line 120),
  `decode`. Also available: `vad.js` (Silero VAD), `resampler.js`,
  `spoken-language-identification.js` (Whisper-based language ID).
- For Parakeet TDT, check the sherpa-onnx Node examples for the exact config (whether
  `modelType: 'nemo_transducer'` is required or detected from model metadata).

## 4. Model facts (verified via the Hugging Face API this session)

### Canary — `csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8`
Pinned revision `9077164e0d3dd1d5353743e89ceaa1d3a770838c`:

| File | Bytes | SHA-256 |
|---|---|---|
| `encoder.int8.onnx` | 132678643 | `7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f` |
| `decoder.int8.onnx` | 74437848 | `e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2` |
| `tokens.txt` | 53555 | not LFS: download once and compute (git oid `da5e7fa593e5f2e3d7a6daa6688da7adebc8336a`) |

Get hashes the same way: `GET https://huggingface.co/api/models/<repo>` → `.sha` (revision), then
`GET .../tree/<revision>` → each file's `lfs.oid` is its SHA-256. Download URL pattern:
`https://huggingface.co/<repo>/resolve/<revision>/<file>`.

Behaviour measured in the earlier session (WASM sherpa-onnx 1.13.6; re-check on native):
- Correct on the en/de/fr samples in the repo's `test_wavs/`, and on Spanish.
- **No automatic language detection**: set `srcLang = tgtLang = <language>` (transcribe, don't
  translate). Default `en`.
- **Empty-result bug:** with `usePnc: 1` (punctuation + casing), some normal clips decode to an
  empty string (3 of 20 real Spanish phone clips from PolyAI/MINDS-14 es-ES, plus Parakeet's
  `test_wavs/es.wav`). The same clips with `usePnc: 0` were all correct. Required fix: if the
  result is empty, `setConfig(... usePnc: 0)`, decode once more, then restore `usePnc: 1`.
- Language switching via `setConfig` is instant (no model reload).
- Trained on segments up to ~40 s → segment longer audio with VAD (SenseVoice uses 30 s).
- Speed (WASM, 1 thread): 4–17 s clips in ~1–4 s.

### Parakeet TDT 0.6B v3 — `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`
Files seen (sizes approximate; **pin revision + SHA-256 the same way**):
`encoder.int8.onnx` ~622 MB, `decoder.int8.onnx` ~11.3 MB, `joiner.int8.onnx` ~6.1 MB, `tokens.txt`.
`test_wavs/` has `de.wav`, `en.wav`, `es.wav`, `fr.wav` (22.05 kHz).
Languages (from NVIDIA's model card; **verify**): bg, cs, da, de, el, en, es, et, fi, fr, hr, hu,
it, lt, lv, mt, nl, pl, pt, ro, ru, sk, sl, sv, uk. Parakeet detects the language itself; it takes
no language hint. Not yet run in any test.

Licences: check both NVIDIA model cards (expected CC-BY-4.0) and add attribution to the README.

## 5. Decisions to confirm with the user before or while building

1. **Language lists (works around Gap 1).** Recommended:
   - `parakeet-local`: `['auto', ...25 codes]`. The hint is accepted but ignored (the model
     auto-detects); listing the codes lets users switch from any provider/language without errors.
   - `canary-local`: `['en','es','de','fr']` **plus `'auto'`**, where `auto` maps to a configurable
     `canary.autoLanguage` (default `en`). Optional upgrade: real detection with
     `spoken-language-identification.js` (needs an extra Whisper model download). Alternative the
     user may prefer: no `auto`, and document "set English first, then switch provider".
   The user had not chosen yet when the session ended.
2. **Where the repo lives:** this folder, `D:\source\repos\dsh\dsh-speech-to-text-nemo` (assumed).

## 6. Suggested layout and work plan

```
dsh-speech-to-text-nemo/
  package.json          # name, dsh.bundle.patch, deps (sherpa-onnx-node 1.13.8, zod, ...), peerDeps as SenseVoice
  cordis.patch.yml      # one insert row (see §3)
  runtime/assets.json   # pinned assets: per model + Silero VAD (copy SenseVoice's VAD entry)
  lib/index.js          # Host plugin: inject ['speechToText','subprocess']; Config; two register() calls
  lib/worker.js         # subprocess: load model by kind (canary|parakeet), VAD segmentation, decode, PnC fallback
  test/*.test.js        # node --test
  README.md
```

1. Load skills: `cordis-plugin-development` (read its `references/host-plugin.md`),
   `cordis-composition-reference`, `verify-package-host-compatibility`,
   `windows-isolated-runtime-with-junctions` (for E2E without touching `~/.dsh`).
2. Read the SenseVoice package (`lib/index.js`, `lib/worker.js`, types, `runtime/assets.json`) and
   reuse its structure. Write our own code; do not import its internal `./worker` (SenseVoice-specific).
3. Pin assets (§4) including `tokens.txt` hashes and the VAD model.
4. Implement Host plugin + worker; provider ids `canary-local`, `parakeet-local`; names like
   `Canary 180M Flash (INT8)` / `Parakeet TDT 0.6B v3 (INT8)`; `setupEstimate` per model.
5. Tests: config validation, language lists, download verification (size/hash mismatch rejected),
   PnC empty-result fallback (mock recognizer), segmentation boundaries.
6. Worker E2E outside DSH: feed 16 kHz mono PCM16 WAVs (resample the 22.05 kHz `test_wavs`) for
   en/es/de/fr on both models; for a harder Spanish set use PolyAI/MINDS-14 es-ES via
   `https://datasets-server.huggingface.co/rows?dataset=PolyAI/minds14&config=es-ES&split=train&offset=0&length=20`
   (clips are 8 kHz G.711 mu-law WAV, format 7: decode to PCM first; sherpa's WAV reader rejects format 7).
7. Install with `plugin_manager` `install_bundle` (absolute path of this folder) — needs approval
   (the earlier session had approvals disabled, so ask the user or have them run it). Then verify:
   the providers appear in the voice settings (provider + language selects, preparation cards),
   preparation downloads and verifies, recording transcribes Spanish, and switching providers works.
8. Check both "voice bundle disabled" (our plugin should wait, since it injects `speechToText`) and
   "our plugin disabled while selected" (service reports provider unavailable).

## 7. Environment notes

- Windows, PowerShell 7. DSH web profile: `C:\Users\pchovan\.dsh\profiles\web`; its `package.json`
  lists `@deepseek-ai/dsh-experimental-voice-input-bundle` and loads `dsh-prompt-enhancer` from
  `file:D:/source/repos/dsh/dsh-prompt-enhancer`.
- `cordis_inspect_query` quirk this session: passing any `input` object was rejected ("input must be
  an object"); calling `Service.listService` with no input works and returns the full catalog.
- Use an isolated `DSH_HOME` for tests; never write into `C:\Users\pchovan\.dsh` directly.
- The DSH 0.2.x voice packages are **experimental**; pin peer versions exactly and re-check after
  every DSH upgrade.

## 8. Background: how we got here (the prompt-enhancer detour)

- Repo `D:\source\repos\dsh\dsh-prompt-enhancer` (upstream `Fishsb/dsh-prompt-enhancer`).
  We added Canary to its own local voice engine: branch `feat/asr-canary-local-multilingual`
  (commit `3251a3c`), also copied to branch `backup` (currently checked out, clean). It was never
  pushed. Local `main` = `f3d5b4f`, 3 commits behind `origin/main`.
- Upstream commit `5d2f21f` (2026-10-13, "P1-a 语音簇缩批减重") then **deleted that engine**
  (`asr-models.cjs`, `asr-worker.cjs`, `asr-deploy.cjs`, cloud engines) and delegated recognition to
  DSH's `ctx.speechToText`. Rebasing onto it is not meaningful, so the user aborted the rebase and the
  prompt-enhancer PR is dropped. This new plugin is the replacement path: it serves DSH's own
  microphone and upstream's refactored prompt-enhancer alike.
- Problems noted in that upstream refactor (possible issue for `Fishsb/dsh-prompt-enhancer`): cloud
  recognition removed with no official cloud provider; undeclared dependency on the experimental
  speech service, failing with a misleading `ASR_LOCAL_WORKER_DOWN`; no cleanup of
  `~/.dsh/dsh-prompt-enhancer-asr` (models, worker, sherpa-onnx); no CHANGELOG entry despite repo rules.
- Reusable logic from the old commit (`3251a3c`, `lib/asr-worker.cjs`): Canary config builder,
  PnC empty-result fallback, freeing streams/recognizers, per-file size checks
  (`lib/asr-models.cjs` `fileMinBytes`).
