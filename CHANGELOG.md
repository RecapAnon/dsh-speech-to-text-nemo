# Changelog

## 0.1.0 — 2026-10-12

- First version. Registers two local recognizers with the DSH speech service: `canary-local` (Canary 180M Flash INT8; en/es/de/fr; no `auto`) and `parakeet-local` (Parakeet TDT 0.6B v3 INT8; `auto` plus 25 language codes, hint ignored). Downloads are pinned and verified, with mirror fallback. Each recognizer runs in its own worker process, which is released after idle. Long recordings are split at silences. Canary retries empty results once without punctuation. Config switches hide either recognizer.
  - Tested: 32 unit tests; end-to-end outside DSH through the plugin's own download, worker and HTTP path on Windows x64. Both models transcribed the sherpa-onnx en/es/de/fr samples correctly. On 20 MINDS-14 Spanish phone clips, WER was 27.0 % for Canary and 24.6 % for Parakeet, with no empty results.
