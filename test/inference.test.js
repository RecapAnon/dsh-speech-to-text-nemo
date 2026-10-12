import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranscriber, parseWorkerConfig, recognizerConfig } from '../lib/inference.js';
import { SpeechInputError } from '../lib/models.js';
import { encodeWave } from '../lib/wave.js';

const base = {
  encoder: 'E', decoder: 'D', joiner: 'J', tokens: 'T', vad: 'V',
  threads: 2, segmentSeconds: 30, vadThreshold: 0.5, minSpeechSeconds: 0.25, minSilenceSeconds: 0.5,
  segmentPaddingSeconds: 0.2, maxAudioBytes: 4 * 1024 * 1024,
};

/**
 * Fake sherpa-onnx: the VAD emits fixed segments (sample ranges) on flush; the recognizer
 * returns `respond(samples, config)` and records every config it is given.
 */
function fakeSherpa({ segments, respond }) {
  const log = { configs: [], decoded: [] };
  class OfflineRecognizer {
    constructor(config) {
      this.config = config;
      log.configs.push(structuredClone(config));
    }
    setConfig(config) {
      this.config = config;
      log.configs.push(structuredClone(config));
    }
    createStream() {
      const stream = { acceptWaveform: ({ samples }) => { stream.samples = samples; } };
      return stream;
    }
    decode(stream) {
      log.decoded.push(stream.samples.length);
      stream.text = respond(stream.samples, this.config.modelConfig);
    }
    getResult(stream) {
      return { text: stream.text };
    }
  }
  class Vad {
    constructor(config, buffer) {
      log.vad = { config, buffer };
      this.queue = [];
      this.total = 0;
    }
    reset() {
      this.queue = [];
      this.total = 0;
      log.resets = (log.resets ?? 0) + 1;
    }
    acceptWaveform(samples) {
      this.total += samples.length;
    }
    flush() {
      for (const [start, end] of segments) this.queue.push({ start, samples: new Float32Array(end - start) });
    }
    isEmpty() {
      return this.queue.length === 0;
    }
    front() {
      return this.queue[0];
    }
    pop() {
      this.queue.shift();
    }
  }
  return { sherpa: { OfflineRecognizer, Vad }, log };
}

const wav = (seconds) => encodeWave(new Float32Array(Math.round(seconds * 16000)));

test('Canary config transcribes (srcLang = tgtLang) with punctuation; Parakeet uses the NeMo transducer', () => {
  const canary = recognizerConfig({ ...base, kind: 'canary' }, 'es', true);
  assert.deepEqual(canary.modelConfig.canary, { encoder: 'E', decoder: 'D', srcLang: 'es', tgtLang: 'es', usePnc: 1 });
  assert.equal(canary.modelConfig.tokens, 'T');
  assert.equal(canary.featConfig.sampleRate, 16000);
  const parakeet = recognizerConfig({ ...base, kind: 'parakeet' }, 'auto', false);
  assert.deepEqual(parakeet.modelConfig.transducer, { encoder: 'E', decoder: 'D', joiner: 'J' });
  assert.equal(parakeet.modelConfig.modelType, 'nemo_transducer');
  assert.equal(parakeet.modelConfig.canary, undefined);
  assert.throws(() => recognizerConfig({ ...base, kind: 'whisper' }, 'en', false), /Unknown NeMo model kind/);
});

test('Canary retries an empty segment once without punctuation, then restores punctuation', () => {
  const { sherpa, log } = fakeSherpa({
    segments: [[0, 16000], [32000, 48000]],
    // First segment is empty with punctuation on (the upstream bug), fine without it.
    respond: (samples, model) => (samples.length > 0 && model.canary.usePnc === 1 && log.decoded.length === 1 ? '' : `seg${log.decoded.length}`),
  });
  const transcribe = createTranscriber({ ...base, kind: 'canary', punctuation: true }, sherpa);
  const result = transcribe(wav(4), 'en');
  assert.equal(result.text, 'seg2 seg3');
  const pnc = log.configs.map((config) => config.modelConfig.canary.usePnc);
  assert.deepEqual(pnc, [1, 0, 1], 'one retry without punctuation, then restored');
  assert.equal(result.audioSeconds, 4);
});

test('Canary with punctuation disabled never retries', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 16000]], respond: () => '' });
  const transcribe = createTranscriber({ ...base, kind: 'canary', punctuation: false }, sherpa);
  assert.equal(transcribe(wav(2), 'en').text, '');
  assert.equal(log.decoded.length, 1);
  assert.equal(log.configs.length, 1);
});

test('Parakeet never retries and ignores the language hint', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 16000]], respond: () => '' });
  const transcribe = createTranscriber({ ...base, kind: 'parakeet' }, sherpa);
  transcribe(wav(2), 'de');
  transcribe(wav(2), 'auto');
  assert.equal(log.configs.length, 1, 'no setConfig for language hints');
  assert.equal(log.decoded.length, 2);
});

test('Canary switches language through setConfig only when it changes', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 8000]], respond: () => 'x' });
  const transcribe = createTranscriber({ ...base, kind: 'canary', punctuation: true }, sherpa);
  transcribe(wav(1), 'en');
  transcribe(wav(1), 'es');
  transcribe(wav(1), 'es');
  transcribe(wav(1), 'fr');
  assert.deepEqual(log.configs.map((config) => config.modelConfig.canary.srcLang), ['en', 'es', 'fr']);
  assert.deepEqual(log.configs.map((config) => config.modelConfig.canary.tgtLang), ['en', 'es', 'fr']);
});

test('unsupported languages and malformed audio are input errors, rejected before inference', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 8000]], respond: () => 'x' });
  const canary = createTranscriber({ ...base, kind: 'canary', punctuation: true }, sherpa);
  assert.throws(() => canary(wav(1), 'auto'), SpeechInputError);
  assert.throws(() => canary(wav(1), 'it'), SpeechInputError);
  assert.throws(() => canary(Buffer.alloc(100), 'en'), SpeechInputError);
  const small = createTranscriber({ ...base, kind: 'parakeet', maxAudioBytes: 1000 }, sherpa);
  assert.throws(() => small(wav(1), 'en'), SpeechInputError);
  assert.throws(() => small(wav(0.01), 'xx'), SpeechInputError);
  assert.equal(log.decoded.length, 0);
});

test('segments are padded with surrounding audio, clipped to the recording', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 16000], [24000, 40000], [60000, 64000]], respond: () => 'x' });
  const transcribe = createTranscriber({ ...base, kind: 'parakeet' }, sherpa);
  transcribe(wav(4), 'auto');
  const pad = 0.2 * 16000;
  assert.deepEqual(log.decoded, [16000 + pad, 16000 + 2 * pad, 4000 + pad]);
});

test('padding never exceeds half the minimum silence', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[16000, 32000]], respond: () => 'x' });
  createTranscriber({ ...base, kind: 'parakeet', minSilenceSeconds: 0.1, segmentPaddingSeconds: 1 }, sherpa)(wav(4), 'auto');
  assert.deepEqual(log.decoded, [16000 + 2 * 800]);
});

test('a segment outside the recording falls back to the VAD samples', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[60000, 70000]], respond: () => 'x' });
  createTranscriber({ ...base, kind: 'parakeet' }, sherpa)(wav(2), 'auto');
  assert.deepEqual(log.decoded, [10000]);
});

test('the VAD is reset for each recording and limits segments to segmentSeconds', () => {
  const { sherpa, log } = fakeSherpa({ segments: [], respond: () => 'x' });
  const transcribe = createTranscriber({ ...base, kind: 'parakeet', segmentSeconds: 20 }, sherpa);
  assert.equal(transcribe(wav(1), 'auto').text, '');
  transcribe(wav(1), 'auto');
  assert.equal(log.resets, 2);
  assert.equal(log.vad.config.sileroVad.maxSpeechDuration, 20);
  assert.equal(log.vad.config.sileroVad.model, 'V');
});

test('parseWorkerConfig rejects missing paths, numbers, and unknown kinds', () => {
  assert.throws(() => parseWorkerConfig(null), /object/);
  assert.throws(() => parseWorkerConfig({ ...base, kind: 'whisper' }), /Unknown/);
  const { joiner, ...noJoiner } = base;
  assert.throws(() => parseWorkerConfig({ ...noJoiner, kind: 'parakeet' }), /joiner/);
  assert.doesNotThrow(() => parseWorkerConfig({ ...noJoiner, kind: 'canary' }));
  assert.throws(() => parseWorkerConfig({ ...base, kind: 'canary', threads: '2' }), /threads/);
});

test('forced VAD splits (touching segments) never decode the same audio twice', () => {
  const { sherpa, log } = fakeSherpa({ segments: [[0, 16000], [16000, 32000]], respond: () => 'x' });
  createTranscriber({ ...base, kind: 'parakeet' }, sherpa)(wav(4), 'auto');
  const pad = 0.2 * 16000;
  assert.deepEqual(log.decoded, [16000 + pad, 16000], 'second segment starts where the first (padded) one ended');
});