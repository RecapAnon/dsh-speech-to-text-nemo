import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createLocalSubprocess } from '../scripts/local-subprocess.mjs';
import { Config } from '../lib/config.js';
import { SpeechDownloadError } from '../lib/downloads.js';
import { apply, inject, name } from '../lib/index.js';
import { PARAKEET_LANGUAGE_CODES, SpeechInputError } from '../lib/models.js';
import { encodeWave } from '../lib/wave.js';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.js', import.meta.url));
let dataRoot;
before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'nemo-provider-'));
});
after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const wav = encodeWave(new Float32Array(16000));

/** Activate the plugin against a fake speech registry and a local subprocess stand-in. */
function activate(overrides = {}, runtime = {}) {
  const subprocess = createLocalSubprocess();
  const providers = new Map();
  const disposers = [];
  const ctx = {
    subprocess,
    logger: { warn() {} },
    effect: (fn) => disposers.push(fn()),
    speechToText: {
      register(provider) {
        if (providers.has(provider.info.id)) throw new Error('duplicate');
        providers.set(provider.info.id, provider);
        return async () => providers.delete(provider.info.id);
      },
    },
  };
  const paths = { encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't', vad: 'v', worker: fakeWorker };
  const calls = { inspect: 0, prepare: 0 };
  const config = Config({ dataRoot, progressIntervalMs: 1, ...overrides });
  apply(ctx, config, {
    inspect: async () => {
      calls.inspect++;
      return runtime.cached ? paths : undefined;
    },
    prepare: async (cfg, kind, signal, report) => {
      calls.prepare++;
      calls.origin = cfg.modelOrigin;
      report({ phase: 'checking', step: 'model', startedAt: Date.now() });
      report({ phase: 'downloading', step: 'model', resource: 'encoder.int8.onnx', completedBytes: 5, totalBytes: 10 });
      if (runtime.hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      if (runtime.fail) throw new SpeechDownloadError({ resource: 'encoder.int8.onnx', source: 'https://huggingface.co', reason: 'dns', code: 'ENOTFOUND' });
      report({ phase: 'checking', step: 'vad', startedAt: Date.now() });
      report({ phase: 'checking', step: 'verify', startedAt: Date.now() });
      return runtime.workerConfig ? { ...paths, ...runtime.workerConfig } : paths;
    },
  });
  const dispose = async () => {
    for (const fn of disposers) await fn();
  };
  return { providers, subprocess, calls, dispose };
}

const until = (provider, phases) => new Promise((resolve) => {
  const check = () => {
    const state = provider.preparation.snapshot();
    if (phases.includes(state.phase)) {
      unsubscribe();
      resolve(state);
    }
  };
  const unsubscribe = provider.preparation.subscribe(check);
  check();
});

test('plugin identity and service dependencies', () => {
  assert.equal(name, 'dsh-speech-to-text-nemo');
  assert.deepEqual(inject, ['speechToText', 'subprocess']);
});

test('registers Canary without auto and Parakeet with auto plus 25 languages', async () => {
  const { providers, dispose } = activate();
  try {
    const canary = providers.get('canary-local');
    const parakeet = providers.get('parakeet-local');
    assert.deepEqual(canary.info.languages, ['en', 'es', 'de', 'fr']);
    assert.equal(canary.info.name, 'Canary 180M Flash (INT8)');
    assert.equal(canary.info.location, 'host-local');
    assert.deepEqual(canary.info.downloadSources, ['https://huggingface.co', 'https://hf-mirror.com']);
    assert.deepEqual(parakeet.info.languages, ['auto', ...PARAKEET_LANGUAGE_CODES]);
    assert.equal(PARAKEET_LANGUAGE_CODES.length, 25);
    assert.ok(parakeet.info.setupEstimate.recommendedDiskBytes > 650e6);
    assert.deepEqual(canary.preparation.snapshot().steps.map((step) => step.kind), ['check', 'model', 'vad', 'verify', 'load']);
  } finally {
    await dispose();
  }
});

test('config switches hide a recognizer; ids and paths are validated', async () => {
  const one = activate({ canary: { enabled: false }, parakeet: { providerId: 'my-parakeet' } });
  assert.deepEqual([...one.providers.keys()], ['my-parakeet']);
  await one.dispose();
  assert.throws(() => activate({ canary: { providerId: 'same' }, parakeet: { providerId: 'same' } }), /different provider ids/);
  assert.throws(() => activate({ dataRoot: 'relative/dir' }), /must be absolute/);
  assert.throws(() => activate({ canary: { modelDirectory: 'models' } }), /must be absolute/);
});

test('offline deployment offers no download sources and skips download steps', async () => {
  const { providers, dispose } = activate({ canary: { modelDirectory: join(dataRoot, 'c') }, vadModelPath: join(dataRoot, 'v.onnx') });
  try {
    const canary = providers.get('canary-local');
    assert.deepEqual(canary.info.downloadSources, []);
    assert.deepEqual(canary.preparation.snapshot().steps.map((step) => step.kind), ['check', 'verify', 'load']);
    assert.deepEqual(providers.get('parakeet-local').preparation.snapshot().steps.map((step) => step.kind), ['check', 'model', 'verify', 'load']);
  } finally {
    await dispose();
  }
});

test('activation only inspects; recording before preparation is refused without downloading', async () => {
  const { providers, calls, subprocess, dispose } = activate();
  try {
    const canary = providers.get('canary-local');
    assert.equal((await until(canary, ['unprepared'])).phase, 'unprepared');
    await assert.rejects(canary.transcribe({ audio: wav, language: 'en' }, AbortSignal.timeout(5000)), /Prepare the local speech provider/);
    assert.equal(calls.prepare, 0);
    assert.equal(subprocess.children.size, 0);
  } finally {
    await dispose();
  }
});

test('prepare right after activation is not swallowed by the cache inspection', async () => {
  const { providers, calls, dispose } = activate({ parakeet: { enabled: false } });
  try {
    const canary = providers.get('canary-local');
    canary.preparation.prepare(); // synchronously, while inspection is still queued
    const state = await until(canary, ['ready', 'failed']);
    assert.equal(state.phase, 'ready');
    assert.equal(calls.prepare, 1);
    assert.ok(state.steps.every((step) => step.status === 'complete'));
  } finally {
    await dispose();
  }
});

test('prepared recognizer transcribes through one reused worker; cached files wake without downloading', async () => {
  const { providers, calls, subprocess, dispose } = activate({ parakeet: { enabled: false } }, { cached: true });
  try {
    const canary = providers.get('canary-local');
    assert.equal((await until(canary, ['standby'])).phase, 'standby');
    const first = await canary.transcribe({ audio: wav, language: 'es' }, AbortSignal.timeout(10_000));
    const second = await canary.transcribe({ audio: wav, language: 'de' }, AbortSignal.timeout(10_000));
    assert.match(first.text, /^canary:es:32044:\d+$/);
    assert.equal(first.text.split(':')[3], second.text.split(':')[3], 'same worker process');
    assert.equal(first.audioSeconds, 1);
    assert.equal(calls.prepare, 0);
    assert.equal(subprocess.children.size, 1);
    assert.equal(canary.preparation.snapshot().phase, 'ready');
  } finally {
    await dispose();
  }
  assert.equal(subprocess.children.size, 0, 'dispose stops the worker');
});

test('an input error keeps the worker; a worker failure or cancellation stops it', async () => {
  const { providers, subprocess, dispose } = activate({ canary: { enabled: false } }, { cached: true });
  try {
    const parakeet = providers.get('parakeet-local');
    await until(parakeet, ['standby']);
    const before = await parakeet.transcribe({ audio: wav, language: 'auto' }, AbortSignal.timeout(10_000));
    await assert.rejects(parakeet.transcribe({ audio: wav, language: 'xx' }, AbortSignal.timeout(10_000)), SpeechInputError);
    const same = await parakeet.transcribe({ audio: wav, language: 'auto' }, AbortSignal.timeout(10_000));
    assert.equal(before.text, same.text, 'input error left the worker running');

    await assert.rejects(parakeet.transcribe({ audio: wav, language: 'crash' }, AbortSignal.timeout(10_000)), /native failure/);
    assert.equal(parakeet.preparation.snapshot().phase, 'standby');
    assert.equal(subprocess.children.size, 0);

    const controller = new AbortController();
    const slow = parakeet.transcribe({ audio: wav, language: 'fr' }, controller.signal);
    setTimeout(() => controller.abort(new Error('user cancelled')), 500);
    await assert.rejects(slow, /user cancelled/);
    assert.equal(subprocess.children.size, 0, 'cancelled inference killed its worker');
    const after = await parakeet.transcribe({ audio: wav, language: 'auto' }, AbortSignal.timeout(10_000));
    assert.notEqual(after.text.split(':')[3], before.text.split(':')[3], 'a fresh worker answered');
  } finally {
    await dispose();
  }
});

test('idle timeout releases the worker and the next recording wakes it', async () => {
  const { providers, subprocess, dispose } = activate({ canary: { enabled: false }, idleTimeoutMs: 200 }, { cached: true });
  try {
    const parakeet = providers.get('parakeet-local');
    await until(parakeet, ['standby']);
    await parakeet.transcribe({ audio: wav, language: 'auto' }, AbortSignal.timeout(10_000));
    assert.equal(subprocess.children.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(subprocess.children.size, 0);
    assert.equal(parakeet.preparation.snapshot().phase, 'standby');
    await parakeet.transcribe({ audio: wav, language: 'auto' }, AbortSignal.timeout(10_000));
    assert.equal(subprocess.children.size, 1);
  } finally {
    await dispose();
  }
});

test('download failures surface safe details; explicit sources must be advertised and disable fallback', async () => {
  const failing = activate({ parakeet: { enabled: false } }, { fail: true });
  try {
    const canary = failing.providers.get('canary-local');
    assert.throws(() => canary.preparation.prepare({ downloadSource: 'https://evil.example' }), /unavailable/);
    canary.preparation.prepare({ downloadSource: 'https://hf-mirror.com' });
    const state = await until(canary, ['failed']);
    assert.deepEqual(state.download, { resource: 'encoder.int8.onnx', source: 'https://huggingface.co', reason: 'dns', code: 'ENOTFOUND' });
    assert.equal(failing.calls.origin, 'https://hf-mirror.com');
    assert.equal(state.steps.find((step) => step.kind === 'model').status, 'failed');
  } finally {
    await failing.dispose();
  }
});

test('cancelling a download publishes cancelled and leaves no worker', async () => {
  const { providers, subprocess, dispose } = activate({ parakeet: { enabled: false } }, { hang: true });
  try {
    const canary = providers.get('canary-local');
    await until(canary, ['unprepared']);
    canary.preparation.prepare();
    await until(canary, ['downloading']);
    await canary.preparation.cancel();
    assert.equal(canary.preparation.snapshot().phase, 'cancelled');
    assert.equal(subprocess.children.size, 0);
  } finally {
    await dispose();
  }
});

test('a worker that dies while loading fails preparation with its stderr', async () => {
  const { providers, dispose } = activate({ parakeet: { enabled: false } }, { workerConfig: {} });
  // Inject a startup failure through the worker config the Host builds.
  const canary = providers.get('canary-local');
  const original = canary.preparation.workerConfig.bind(canary.preparation);
  canary.preparation.workerConfig = (paths) => ({ ...original(paths), failStartup: true });
  try {
    canary.preparation.prepare();
    const state = await until(canary, ['failed']);
    assert.match(state.message, /exited before readiness: model failed to load/);
    assert.equal(state.steps.find((step) => step.kind === 'load').status, 'failed');
  } finally {
    await dispose();
  }
});
