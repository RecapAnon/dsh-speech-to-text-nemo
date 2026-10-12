/** CPU inference with Silero VAD segmentation; runs only inside the worker process. */
import { MODEL_FILES, MODELS, SpeechInputError } from './models.js';
import { validateWave, wavSamples } from './wave.js';

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

/**
 * Check the Host-built worker config. The plugin already validated it; this guards the process boundary.
 * @param {unknown} raw - parsed argv JSON.
 * @returns {object} the same object.
 */
export function parseWorkerConfig(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('Speech worker config must be an object');
  if (!Object.hasOwn(MODEL_FILES, raw.kind)) throw new Error(`Unknown NeMo model kind: ${raw.kind}`);
  for (const key of [...MODEL_FILES[raw.kind], 'vad']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') throw new Error(`Speech worker config is missing path: ${key}`);
  }
  for (const key of ['threads', 'segmentSeconds', 'vadThreshold', 'minSpeechSeconds', 'minSilenceSeconds', 'maxAudioBytes']) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`Speech worker config is missing number: ${key}`);
  }
  return raw;
}

/**
 * Build the sherpa-onnx OfflineRecognizer config for one model kind.
 * @param {object} config - worker config with verified paths.
 * @param {string} language - Canary source/target language; ignored by Parakeet.
 * @param {boolean} punctuation - Canary punctuation and casing.
 * @returns {object} native recognizer config.
 */
export function recognizerConfig(config, language, punctuation) {
  const modelConfig = {
    tokens: config.tokens,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  };
  if (config.kind === 'canary') {
    // srcLang = tgtLang: transcribe, never translate.
    modelConfig.canary = {
      encoder: config.encoder,
      decoder: config.decoder,
      srcLang: language,
      tgtLang: language,
      usePnc: punctuation ? 1 : 0,
    };
  } else if (config.kind === 'parakeet') {
    modelConfig.transducer = { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner };
    modelConfig.modelType = 'nemo_transducer';
  } else {
    throw new Error(`Unknown NeMo model kind: ${config.kind}`);
  }
  // NeMo models carry their real feature size in model metadata; 80 matches the upstream examples.
  return { featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig };
}

/**
 * Validate one request before it touches native code.
 * @returns {number} audio duration in seconds.
 */
export function validateInput(kind, audio, language, maxAudioBytes) {
  if (!MODELS[kind].languages.includes(language)) throw new SpeechInputError(`Unsupported ${MODELS[kind].name} language: ${language}`);
  if (audio.byteLength > maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit');
  try {
    return validateWave(audio, maxAudioBytes / 32000);
  } catch (error) {
    throw new SpeechInputError('Invalid speech WAV', { cause: error });
  }
}

/**
 * Load one model and return a synchronous transcription function.
 * @param {object} config - worker config: kind, verified paths, threads, VAD limits, punctuation.
 * @param {object} sherpa - the `sherpa-onnx-node` module (injectable for tests).
 * @returns {(audio: Uint8Array, language: string) => { text: string, audioSeconds: number, inferenceSeconds: number }}
 */
export function createTranscriber(config, sherpa) {
  const punctuation = config.kind === 'canary' && config.punctuation !== false;
  let language = config.kind === 'canary' ? 'en' : 'auto';
  const recognizer = new sherpa.OfflineRecognizer(recognizerConfig(config, language, punctuation));
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: config.vadThreshold,
      minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds,
      maxSpeechDuration: config.segmentSeconds,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1);
  const padding = Math.round(Math.min(config.segmentPaddingSeconds ?? 0, config.minSilenceSeconds / 2) * SAMPLE_RATE);

  const decode = (samples) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    recognizer.decode(stream);
    return recognizer.getResult(stream).text.trim();
  };

  // Canary sometimes ends a normal utterance at its first token when punctuation is on, returning
  // an empty string. sherpa-onnx 1.13.8 mitigates this natively (issue #3919); as a safety net,
  // an empty segment is decoded once more without punctuation.
  const decodeSegment = (samples) => {
    const text = decode(samples);
    if (text || !punctuation) return text;
    recognizer.setConfig(recognizerConfig(config, language, false));
    try {
      return decode(samples);
    } finally {
      recognizer.setConfig(recognizerConfig(config, language, true));
    }
  };

  return (audio, requested) => {
    const audioSeconds = validateInput(config.kind, audio, requested, config.maxAudioBytes);
    const samples = wavSamples(audio);
    if (config.kind === 'canary' && requested !== language) {
      // Changing the decoder prompt is instant; the model is not reloaded.
      recognizer.setConfig(recognizerConfig(config, requested, punctuation));
      language = requested;
    }
    detector.reset();
    const started = performance.now();
    const texts = [];
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false);
        detector.pop();
        const end = segment.start + segment.samples.length;
        if (!Number.isSafeInteger(segment.start) || segment.start < 0 || end > samples.length) {
          texts.push(decodeSegment(segment.samples));
          continue;
        }
        // Silero trims speech tightly; a little surrounding audio helps the first and last words.
        texts.push(decodeSegment(samples.subarray(Math.max(0, segment.start - padding), Math.min(samples.length, end + padding))));
      }
    };
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
      detector.acceptWaveform(samples.subarray(offset, offset + VAD_WINDOW));
      drain();
    }
    detector.flush();
    drain();
    return {
      text: texts.filter(Boolean).join(' ').trim(),
      audioSeconds,
      inferenceSeconds: (performance.now() - started) / 1000,
    };
  };
}
