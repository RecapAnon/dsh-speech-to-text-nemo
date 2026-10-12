/** Plugin configuration, validated by the Loader at activation and shown in Settings. */
import Schema from '@deepseek-ai/schemastery';

/** Largest timer delay Node accepts without overflowing to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const origin = Schema.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/);
const optionalPath = Schema.union([Schema.string().min(1), Schema.const(undefined)]);

const model = (providerId, extra = {}) => Schema.object({
  enabled: Schema.boolean().default(true).description('Register this recognizer. Disable to hide it without uninstalling.'),
  providerId: Schema.string().min(1).default(providerId).description('Provider id shown to the speech service.'),
  modelDirectory: optionalPath.description('Absolute directory with pre-downloaded model files (offline deployment). Files there are used as-is, without downloads or hash checks.'),
  ...extra,
});

/** Validate deployment-varying runtime choices. */
export const Config = Schema.object({
  dataRoot: Schema.string().min(1).required().description('Absolute directory for downloaded models.'),
  canary: model('canary-local', {
    punctuation: Schema.boolean().default(true).description('Ask Canary for punctuation and capitalisation. Empty results are retried once without it.'),
  }).description('NVIDIA Canary 180M Flash: English, Spanish, German, French. Needs a language; no automatic detection.'),
  parakeet: model('parakeet-local').description('NVIDIA Parakeet TDT 0.6B v3: 25 European languages, detected automatically.'),
  vadModelPath: optionalPath.description('Absolute path of an existing silero_vad.onnx (offline deployment). Omit to download the pinned copy.'),
  modelOrigin: Schema.union([origin, Schema.const(undefined)]).description('Use only this download origin, without fallback.'),
  modelOrigins: Schema.array(origin).min(1).default(['https://huggingface.co', 'https://hf-mirror.com']).description('Download origins, probed in parallel; the first to answer is tried first.'),
  modelProbeTimeoutMs: Schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3000),
  threads: Schema.natural().min(1).max(64).default(2).description('CPU threads per recognizer worker.'),
  segmentSeconds: Schema.number().min(1).max(40).default(30).description('Longest speech segment passed to the model; longer speech is split at silences, or cut at this length.'),
  vadThreshold: Schema.number().min(0).max(1).default(0.5),
  minSpeechSeconds: Schema.number().min(0).default(0.25),
  minSilenceSeconds: Schema.number().min(0.01).default(0.5),
  segmentPaddingSeconds: Schema.number().min(0).max(1).default(0.2).description('Audio kept before and after each detected speech segment.'),
  maxAudioBytes: Schema.natural().min(46).default(4 * 1024 * 1024).description('Largest accepted recording (16 kHz PCM16 is 32 000 bytes per second).'),
  prepareTimeoutMs: Schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3_600_000),
  inferenceTimeoutMs: Schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  idleTimeoutMs: Schema.natural().max(MAX_TIMER_DELAY_MS).default(300_000).description('Stop an unused worker after this delay; 0 keeps it loaded.'),
  maxPending: Schema.natural().min(1).default(4),
  graceMs: Schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1000),
  maxLogBytes: Schema.natural().min(1).default(64 * 1024),
  maxResponseBytes: Schema.natural().min(1).default(128 * 1024),
  progressIntervalMs: Schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(100),
});
