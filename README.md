# dsh-speech-to-text-nemo

Local speech recognizers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) voice input, based on NVIDIA NeMo models run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx):

| Recognizer (provider id) | Model | Languages | Download |
|---|---|---|---|
| **Canary 180M Flash (INT8)** (`canary-local`) | [nvidia/canary-180m-flash](https://huggingface.co/nvidia/canary-180m-flash) | English, Spanish, German, French (`en` `es` `de` `fr`) | ≈ 209 MB |
| **Parakeet TDT 0.6B v3 (INT8)** (`parakeet-local`) | [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | 25 European languages, detected automatically | ≈ 672 MB |

Parakeet's languages: `bg` `cs` `da` `de` `el` `en` `es` `et` `fi` `fr` `hr` `hu` `it` `lt` `lv` `mt` `nl` `pl` `pt` `ro` `ru` `sk` `sl` `sv` `uk`.

The plugin adds both recognizers to DSH's own speech service, the same way the official SenseVoice package does. It needs no fork or UI changes. Everything that uses DSH speech recognition can use them: the composer microphone, and other plugins that call the speech service.

Audio never leaves the machine. Models download only when you prepare a recognizer, and only the recognizers you prepare are downloaded.

## Requirements

- DeepSeek Harness **0.2.1-rc.2** with the official voice input bundle (`@deepseek-ai/dsh-experimental-voice-input-bundle`) enabled. It provides the speech service this plugin registers with. Without it, this plugin waits and does nothing.
- Windows x64, Linux x64/arm64, or macOS. Disk and memory per recognizer:
  - Canary: about 300 MB disk and 0.6 GB memory while loaded.
  - Parakeet: about 800 MB disk and 1.0 GB memory while loaded.

The DSH voice packages are experimental, so `package.json` pins them to exactly `0.2.1-rc.2`. After a DSH upgrade, DSH reports this plugin as incompatible until it is re-tested and the pin is raised.

## Install

In DSH, install the bundle from this folder with the Plugin Manager, or ask the agent to run `plugin_manager install_bundle` with the folder's absolute path. The bundle adds one plugin row:

```yaml
- id: speech-to-text-nemo
  name: dsh-speech-to-text-nemo
  config:
    dataRoot: !!js dshHomePath('speech-to-text', 'nemo')
```

Models are stored under `~/.dsh/speech-to-text/nemo/models/`.

When installed from a local folder, DSH links the profile to that folder (`link:`). The plugin then loads its dependencies (`sherpa-onnx-node` and its native binary) from the folder's own `node_modules`. Keep it in place: run `pnpm install` there after cloning, and don't delete `node_modules`. After changing the code, restart DSH; a running DSH keeps the module it already loaded.

## Use

1. Open the voice input settings. The recognizer list now includes **Canary 180M Flash (INT8)** and **Parakeet TDT 0.6B v3 (INT8)**. Each has its own preparation card.
2. On the card of the recognizer you want, choose a download source and prepare it. Progress, verification, and errors appear on the card.
3. Select the recognizer and a language, then record as usual.

Workers start on the first recording and stop after 5 idle minutes. The next recording restarts them in a few seconds.

### Switching recognizers: pick a shared language first

DSH checks the **saved language** against the recognizer you switch to. If the new recognizer doesn't support that language, the switch is refused with an error such as `Speech provider canary-local does not support language: auto`. This happens in the official UI, so this plugin cannot fix it.

Canary has no automatic language detection, so it does not offer `auto`. Before switching recognizer, select a language both recognizers support. English works for all of them:

| From → to | Do this first |
|---|---|
| SenseVoice (`auto`, `zh`, …) → Canary | Select `en` in SenseVoice, then switch to Canary. |
| Canary (`es`/`de`/`fr`) → SenseVoice | Select `en` in Canary, then switch. |
| Anything → Parakeet | Nothing: Parakeet accepts every language code (and `auto`). |
| Parakeet → SenseVoice or Canary | Select a language the target supports (`en` works for both), then switch. |

Parakeet ignores the language you choose and detects the language itself. It lists all its codes only so that switching to it never fails.

### Language names show as codes

The official UI only has display names for `auto`, `zh`, `en`, `yue`, `ja` and `ko`. Other languages appear as their codes, such as `es`, `de` or `fr`.

## Configuration

Every field is optional except `dataRoot`, which the bundle sets. Change these in the plugin's settings.

| Key | Default | Meaning |
|---|---|---|
| `canary.enabled` / `parakeet.enabled` | `true` | Register the recognizer. Set to `false` to hide one without uninstalling. |
| `canary.providerId` / `parakeet.providerId` | `canary-local` / `parakeet-local` | Ids seen by the speech service. |
| `canary.punctuation` | `true` | Ask Canary for punctuation and capitalisation. |
| `canary.modelDirectory` / `parakeet.modelDirectory` | — | Absolute folder with pre-downloaded model files, for offline use. These files are used as-is, without downloads or hash checks. |
| `vadModelPath` | — | Absolute path of an existing `silero_vad.onnx`, for offline use. |
| `modelOrigins` | `https://huggingface.co`, `https://hf-mirror.com` | Download origins. |
| `modelOrigin` | — | Use only this origin, without fallback. |
| `threads` | `2` | CPU threads per worker. |
| `segmentSeconds` | `30` | Longest piece of speech sent to the model at once (max 40; Canary was trained on ≤ 40 s). |
| `segmentPaddingSeconds` | `0.2` | Audio kept around each detected speech segment. |
| `idleTimeoutMs` | `300000` | Stop an unused worker after this long; `0` keeps it loaded. |
| `maxAudioBytes` | 4 MiB | Longest accepted recording (about 131 s). |

The remaining keys (`vadThreshold`, `minSpeechSeconds`, `minSilenceSeconds`, timeouts, queue and log limits) behave as in the official SenseVoice provider.

## How it works

- **Pinned downloads.** `runtime/assets.json` fixes the Hugging Face revision, byte size and SHA-256 of every file. Origins are probed in parallel and the first to answer is tried first. On network, HTTP, certificate or integrity failures, the download moves to the next origin. Files download into a temporary `.part` file and are renamed only after verification. Verified files are reused.
- **Activation does no work.** On start, the plugin checks whether verified files exist and shows each recognizer as ready to wake or as not prepared. It downloads and loads nothing.
- **One worker process per recognizer.** It is started through DSH's subprocess service, loads its model once, and serves requests one at a time on a loopback port protected by a random token. Cancelling a recording or hitting a timeout stops the worker so no inference keeps running.
- **Long recordings are split at silences** by Silero VAD, in pieces of at most `segmentSeconds`. Each piece keeps `segmentPaddingSeconds` of surrounding audio, but no audio is decoded twice when continuous speech is cut at the length limit.
- **Recordings never wait behind a download.** A recording made while a recognizer is still downloading is refused at once. A recording cancelled while queued is released at once. A recording cancelled mid-inference stops the worker before it returns.
- **Leftover `.part` files** from an interrupted DSH are deleted the next time that recognizer is prepared.
- **Canary language.** The requested language is used as both source and target, so Canary transcribes and never translates. Changing language doesn't reload the model.
- **Canary empty results.** With punctuation on, Canary sometimes ended a normal utterance at its first token and returned nothing. sherpa-onnx 1.13.8 now prevents this itself (it logs `The first generated token is <|endoftext|> … Using the best non-eos token instead`). As a safety net, an empty piece is decoded once more without punctuation.

## Measured results

These were measured on Windows x64 with 2 threads, through the plugin's own download, worker and HTTP path (`npm run e2e`). The Spanish set is 20 phone recordings from [PolyAI/MINDS-14](https://huggingface.co/datasets/PolyAI/minds14) (`es-ES`, 8 kHz, 415 reference words).

| | Canary 180M Flash | Parakeet TDT 0.6B v3 |
|---|---|---|
| sherpa-onnx sample clips (en/es/de/fr) | all correct | all correct |
| MINDS-14 es WER | 27.0 % | 24.6 % |
| Real-time factor (lower is faster) | 0.24 | 0.20 |
| Peak worker memory | 587 MB | 997 MB |
| 103 s recording (VAD-split) | 21.5 s | 20.9 s |
| Empty results | 0 / 25 | 0 / 25 |
| Prepare from scratch (download + verify) | 11 s | 25 s |
| Prepare with verified files (hash check + load) | 1.9 s | 2.3 s |

Some MINDS-14 reference transcripts are cut short, which inflates WER for both models in the same way. Use the numbers to compare the two models, not as absolute accuracy.

Canary's punctuation-off retry fired on 0 of the 24 clips (`node scripts/pnc-check.mjs`). The fix inside sherpa-onnx handled the two pieces where it would otherwise have triggered.

## Models and licences

This plugin's code is MIT-licensed. The model files it downloads have their own licences:

- **Canary 180M Flash** and **Parakeet TDT 0.6B v3** by NVIDIA, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model cards: [canary-180m-flash](https://huggingface.co/nvidia/canary-180m-flash), [parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). The ONNX INT8 conversions come from [csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8) and [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8).
- **Silero VAD** ([snakers4/silero-vad](https://github.com/snakers4/silero-vad), MIT), from [csukuangfj/vad](https://huggingface.co/csukuangfj/vad).
- **sherpa-onnx** runtime ([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0).

## Development

```powershell
pnpm install
pnpm test                       # unit tests (no native code, no network)
node scripts/e2e.mjs            # real downloads into .dev-cache/, real workers, real audio
node scripts/e2e.mjs --only canary --minds 5
node scripts/pnc-check.mjs      # count Canary punctuation-off retries on the cached clips
```

- `lib/index.js` is the Host plugin entry. It validates config and registers one provider per enabled model.
- `lib/provider.js` holds the preparation state, the worker lifecycle and the request queue.
- `lib/runtime.js` and `lib/downloads.js` handle model paths and pinned, verified downloads.
- `lib/worker.js`, `lib/process-server.js` and `lib/inference.js` run in the worker process: loopback HTTP, sherpa-onnx, VAD, and the Canary retry.
