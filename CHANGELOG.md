# Changelog

## 0.1.0 — 2026-10-12

- First version. It registers two local recognizers with the DSH speech service:
  - `canary-local`: Canary 180M Flash INT8; en/es/de/fr; no `auto`.
  - `parakeet-local`: Parakeet TDT 0.6B v3 INT8; `auto` plus 25 language codes; the language hint is ignored.
- Downloads are pinned and verified, with mirror fallback. Each recognizer runs in its own worker process, which is released after idle. Long recordings are split at silences. Canary retries empty results once without punctuation. Config switches hide either recognizer.
- The native sherpa-onnx binaries are pinned to 1.13.8.
- Hardened after code review, before release:
  - Cancelling a preparation that was still queued (behind a recording waking the worker, or behind the start-up cache check) no longer leaves the recognizer stuck in "cancelled".
  - Recordings made during a download, and queued recordings that are cancelled, are released at once.
  - Padding no longer decodes audio twice at forced VAD splits.
  - Stale `.part` files are removed.
  - A failed idle stop no longer breaks the next recording.
- Tested:
  - 38 unit tests, stable over 5 runs. Each review fix has a regression test that fails without the fix. The one exception is the "re-assert ready" guard, which another guard also covers.
  - End-to-end outside DSH, on Windows x64, through the plugin's own download, worker and HTTP path. Both models transcribed the sherpa-onnx en/es/de/fr samples correctly. On 20 MINDS-14 Spanish phone clips, WER was 27.0 % for Canary and 24.6 % for Parakeet, with no empty results.
  - Installed into the DSH web profile: the plugin row is active. Not yet tested by recording in the DSH UI.
