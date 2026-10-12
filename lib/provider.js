/**
 * Host-side owner of one recognizer: preparation state for the speech UI, one serial worker
 * process started on first use and released after idle, and request-owned cancellation.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { SpeechDownloadError, deadline } from './downloads.js';
import { MODEL_FILES, SpeechInputError } from './models.js';
import { inspectRuntime, prepareRuntime } from './runtime.js';

const SETTLED_PHASES = ['ready', 'standby', 'unprepared', 'failed', 'cancelled'];

/** Wait for a cancellable operation without losing ownership of its eventual settlement. */
function waitFor(pending, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Speech operation cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Read the worker's single readiness line, rejecting an early exit.
 * @returns {Promise<number>} loopback port.
 */
export async function readReady(handle, limit, signal) {
  if (!handle.stdout) throw new Error('Speech worker stdout is unavailable');
  signal.throwIfAborted();
  const stdout = handle.stdout;
  let text = '';
  const pending = Promise.withResolvers();
  const data = (chunk) => {
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > limit) {
      pending.reject(new Error('Speech worker readiness exceeded its byte limit'));
      return;
    }
    const end = text.indexOf('\n');
    if (end < 0) return;
    try {
      const value = JSON.parse(text.slice(0, end));
      if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535 || Object.keys(value).length !== 1) {
        throw new Error('Unexpected readiness payload');
      }
      pending.resolve(value.port);
    } catch (error) {
      pending.reject(new Error('Invalid speech worker readiness', { cause: error }));
    }
  };
  stdout.on('data', data);
  stdout.on('error', pending.reject);
  handle.done.then(() => {
    pending.reject(new Error(`Speech worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text ?? ''}`.trim()));
  }, pending.reject);
  try {
    return await waitFor(pending.promise, signal);
  } finally {
    stdout.off('data', data);
    stdout.off('error', pending.reject);
    stdout.resume();
  }
}

/**
 * Decode a bounded worker response.
 * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number }>}
 */
export async function readTranscript(response, limit) {
  if (!response.body) throw new Error('Speech worker returned no response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Speech transcript exceeded its byte limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok) {
    const message = typeof value?.error === 'string' ? value.error : `Speech worker failed with HTTP ${response.status}`;
    if ((response.status === 400 || response.status === 413) && value?.code === 'invalid-input') throw new SpeechInputError(message);
    throw new Error(message);
  }
  if (typeof value?.text !== 'string' || !(value.audioSeconds >= 0) || !(value.inferenceSeconds >= 0)) {
    throw new Error('Speech worker returned a malformed transcript');
  }
  return { text: value.text, audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds };
}

/** One recognizer kind (Canary or Parakeet) behind the speech service's preparation contract. */
export class NemoRecognizer {
  tail = Promise.resolve();
  pending = 0;
  lifetime = new AbortController();
  listeners = new Set();
  lastProgressAt = 0;
  idle;
  worker;
  runtime;
  preparing;
  running;

  /**
   * @param {object} ctx - Host context: `subprocess`, `logger`.
   * @param {object} config - validated plugin config.
   * @param {'canary'|'parakeet'} kind - which model this instance runs.
   * @param {object} [options] - test seams: `inspect`, `prepare` (runtime functions), `execPath`.
   */
  constructor(ctx, config, kind, options = {}) {
    this.ctx = ctx;
    this.config = config;
    this.kind = kind;
    this.inspectRuntime = options.inspect ?? inspectRuntime;
    this.prepareRuntime = options.prepare ?? prepareRuntime;
    this.execPath = options.execPath ?? process.execPath;
    const managedModel = config[kind].modelDirectory === undefined;
    const managedVad = config.vadModelPath === undefined;
    /** Origins offered for an explicit download; offline deployments offer none. */
    this.downloadSources = !managedModel && !managedVad ? []
      : [...new Set((config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]).map((origin) => new URL(origin).origin))];
    const kinds = ['check', ...(managedModel ? ['model'] : []), ...(managedVad ? ['vad'] : []), 'verify', 'load'];
    this.state = { phase: 'unprepared', steps: kinds.map((stepKind) => ({ kind: stepKind, status: 'pending' })) };
  }

  /** @returns {object} the current preparation state. */
  snapshot() {
    return this.state;
  }

  /** @returns {() => void} unsubscribe. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(state) {
    // Only the task that is actually executing can complete; a queued request stays cancellable.
    if (this.running && SETTLED_PHASES.includes(state.phase)) this.running.completed = true;
    const previous = this.state;
    const steps = state.steps ?? previous.steps.map((item) => {
      if (state.phase === 'ready') return { ...item, status: 'complete' };
      if (state.step === 'check' && item.kind !== 'check') return { kind: item.kind, status: 'pending' };
      if (state.step === item.kind) return item.status === 'running' ? item : { kind: item.kind, status: 'running', startedAt: Date.now() };
      if (item.status !== 'running') return item;
      if (state.phase === 'standby') return { ...item, status: 'cancelled' };
      if (state.phase === 'failed' || state.phase === 'cancelled') return { ...item, status: state.phase };
      return state.step === undefined ? item : { ...item, status: 'complete' };
    });
    this.state = { ...state, steps };
    const now = performance.now();
    if (state.phase === 'downloading' && previous.phase === 'downloading' && state.resource === previous.resource
      && state.completedBytes !== state.totalBytes && now - this.lastProgressAt < this.config.progressIntervalMs) return;
    this.lastProgressAt = now;
    for (const listener of this.listeners) listener();
  }

  /** Check disk caches on activation; verified files enter standby without starting a worker. */
  inspect() {
    this.runPreparation(async (signal) => {
      const inspection = deadline(signal, this.config.prepareTimeoutMs, 'SPEECH_PREPARE_TIMEOUT');
      try {
        this.publish({ phase: 'checking', step: 'check', startedAt: Date.now() });
        const runtime = await this.inspectRuntime(this.config, this.kind, inspection.signal);
        inspection.signal.throwIfAborted();
        this.runtime = runtime;
        this.publish({
          phase: runtime ? 'standby' : 'unprepared',
          steps: this.state.steps.map(({ kind }) => ({
            kind,
            status: kind === 'check' || (runtime && kind !== 'load') ? 'complete' : 'pending',
          })),
        });
      } finally {
        inspection[Symbol.dispose]();
      }
    }, undefined, true);
  }

  /**
   * Start or join preparation.
   * @param {{ downloadSource?: string }} [options] - an explicit source must be advertised and disables fallback.
   */
  prepare(options = {}) {
    const source = options.downloadSource;
    if (source !== undefined && !this.downloadSources.includes(source)) throw new Error('Speech download source is unavailable');
    const config = source === undefined ? this.config : { ...this.config, modelOrigin: source };
    this.runPreparation(async (signal) => {
      await this.start(signal, config);
    }, source);
  }

  /** The state that actually holds right now, independent of any queued request. */
  settledState() {
    const kinds = this.state.steps.map((step) => step.kind);
    if (this.worker && !this.worker.closed) return { phase: 'ready', steps: kinds.map((kind) => ({ kind, status: 'complete' })) };
    if (this.runtime) return { phase: 'standby', steps: kinds.map((kind) => ({ kind, status: kind === 'load' ? 'pending' : 'complete' })) };
    return { phase: 'unprepared', steps: kinds.map((kind) => ({ kind, status: kind === 'check' ? 'complete' : 'pending' })) };
  }

  runPreparation(run, downloadSource, inspection = false) {
    if (this.worker) {
      // Already loaded (perhaps woken by a recording while a request was queued): just say so.
      if (!this.worker.closed && this.state.phase !== 'ready') this.publish(this.settledState());
      return;
    }
    // A cache inspection never satisfies a real preparation request: queue the request behind it.
    const joinable = this.preparing && !(this.preparing.inspection && !inspection);
    if (joinable && this.preparing.downloadSource !== downloadSource) throw new Error('Cancel preparation before changing its download source');
    if (joinable) return;
    this.lifetime.signal.throwIfAborted();
    const abort = new AbortController();
    const task = { abort, settled: Promise.resolve(), completed: false, started: false, downloadSource, inspection };
    this.preparing = task;
    const owned = async (signal) => {
      task.started = true;
      this.running = task;
      try {
        await run(signal);
      } finally {
        if (this.running === task) this.running = undefined;
      }
    };
    task.settled = this.enqueue(owned, abort.signal).catch((error) => {
      if (this.lifetime.signal.aborted) return;
      if (abort.signal.aborted && !task.started) {
        // Cancelled while still queued: nothing changed, so restore the real state.
        this.publish(this.settledState());
        return;
      }
      this.publish(abort.signal.aborted ? { phase: 'cancelled' } : {
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof SpeechDownloadError ? { download: error.download } : {}),
      });
    }).finally(() => {
      if (this.preparing === task) this.preparing = undefined;
    });
  }

  /** Cancel unfinished preparation; completed readiness is kept. */
  async cancel() {
    const task = this.preparing;
    if (!task) return;
    if (!task.completed) {
      if (task.started) this.publish({ phase: 'cancelling', startedAt: Date.now() });
      task.abort.abort(new Error('Speech preparation cancelled'));
    }
    await task.settled;
    // The task may have finished just before the abort landed; never leave a stale 'cancelling'.
    if (this.state.phase === 'cancelling' && !this.lifetime.signal.aborted) this.publish(this.settledState());
  }

  /**
   * Queue one recording. Verified resources accept recordings while the worker wakes;
   * other states reject at once, without waiting behind a download.
   */
  async transcribe(input, signal) {
    const usable = this.runtime !== undefined || ['ready', 'standby'].includes(this.state.phase) || this.preparing?.inspection;
    if (!usable) throw new Error('Prepare the local speech provider before recording');
    return await this.enqueue(async (combined) => await this.execute(input, combined), signal);
  }

  /**
   * Run jobs one at a time. A caller cancelled before its job starts is released at once; once
   * started, the job settles only after its resources are cleaned up (worker stopped if needed).
   */
  async enqueue(run, signal) {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    combined.throwIfAborted();
    if (this.pending >= this.config.maxPending) throw new Error('Speech transcription queue is full');
    clearTimeout(this.idle);
    this.pending++;
    let started = false;
    const job = this.tail.then(async () => {
      combined.throwIfAborted();
      started = true;
      return await run(combined);
    });
    this.tail = job.then(() => undefined, () => undefined).finally(() => {
      this.pending--;
      if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
        this.idle = setTimeout(() => {
          this.tail = this.tail.then(async () => await this.stop()).catch((error) => {
            this.ctx.logger?.warn?.('Speech worker idle cleanup failed', error);
          });
        }, this.config.idleTimeoutMs);
        this.idle.unref?.();
      }
    });
    return await new Promise((resolve, reject) => {
      const abort = () => {
        if (!started) reject(combined.reason instanceof Error ? combined.reason : new Error('Speech operation cancelled'));
      };
      combined.addEventListener('abort', abort, { once: true });
      job.then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
    });
  }

  /** Build the JSON handed to the worker process. */
  workerConfig(paths) {
    const files = Object.fromEntries(MODEL_FILES[this.kind].map((file) => [file, paths[file]]));
    return {
      kind: this.kind,
      ...files,
      vad: paths.vad,
      threads: this.config.threads,
      segmentSeconds: this.config.segmentSeconds,
      vadThreshold: this.config.vadThreshold,
      minSpeechSeconds: this.config.minSpeechSeconds,
      minSilenceSeconds: this.config.minSilenceSeconds,
      segmentPaddingSeconds: this.config.segmentPaddingSeconds,
      maxAudioBytes: this.config.maxAudioBytes,
      punctuation: this.kind === 'canary' ? this.config.canary.punctuation : false,
    };
  }

  async start(signal, preparationConfig = this.config) {
    if (this.worker?.closed) await this.stop();
    if (this.worker) {
      if (this.state.phase !== 'ready') this.publish({ phase: 'ready' });
      return this.worker;
    }
    const setup = deadline(signal, this.config.prepareTimeoutMs, 'SPEECH_PREPARE_TIMEOUT');
    try {
      const cached = this.runtime !== undefined;
      if (!cached) this.publish({ phase: 'checking', step: 'check', startedAt: Date.now() });
      const runtime = this.runtime ?? await this.prepareRuntime(preparationConfig, this.kind, setup.signal, (state) => this.publish(state), setup.timedOut);
      this.runtime = runtime;
      setup.signal.throwIfAborted();
      this.publish({ phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() });
      await mkdir(this.config.dataRoot, { recursive: true });
      const token = randomBytes(32).toString('hex');
      const handle = this.ctx.subprocess.spawn({
        argv: [this.execPath, runtime.worker, JSON.stringify(this.workerConfig(runtime))],
        cwd: this.config.dataRoot,
        graceMs: this.config.graceMs,
        env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.config.maxLogBytes } },
      });
      try {
        const port = await readReady(handle, this.config.maxLogBytes, setup.signal);
        const worker = { handle, url: `http://127.0.0.1:${port}`, token, closed: false };
        this.worker = worker;
        this.publish({ phase: 'ready' });
        const exited = () => {
          if (!worker.closed) {
            worker.closed = true;
            this.publish({ phase: 'standby' });
          }
        };
        handle.done.then(exited, exited);
        return worker;
      } catch (error) {
        handle.terminate();
        await handle.waitForExit();
        throw error;
      }
    } finally {
      setup[Symbol.dispose]();
    }
  }

  async execute(input, signal) {
    const phase = this.state.phase;
    if (phase !== 'ready' && phase !== 'standby') throw new Error('Prepare the local speech provider before recording');
    try {
      const worker = await this.start(signal);
      const call = deadline(signal, this.config.inferenceTimeoutMs, 'SPEECH_INFERENCE_TIMEOUT');
      try {
        const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'audio/wav' },
          body: Buffer.from(input.audio.buffer, input.audio.byteOffset, input.audio.byteLength),
          signal: call.signal,
        });
        const result = await readTranscript(response, this.config.maxResponseBytes).catch((error) => {
          call.signal.throwIfAborted();
          throw error;
        });
        call.signal.throwIfAborted();
        return result;
      } finally {
        call[Symbol.dispose]();
      }
    } catch (error) {
      if (error instanceof SpeechInputError) throw error;
      // Cancellation or a timeout may leave native inference running: kill the worker.
      await this.stop();
      this.publish({ phase: 'standby' });
      throw error;
    }
  }

  async stop() {
    const worker = this.worker;
    if (!worker) return;
    worker.closed = true;
    worker.handle.terminate();
    await worker.handle.waitForExit();
    this.worker = undefined;
    this.publish({ phase: 'standby' });
  }

  /** Close admission, settle queued work, and stop the worker. */
  async dispose() {
    this.listeners.clear();
    this.lifetime.abort(new Error('NeMo speech provider disposed'));
    clearTimeout(this.idle);
    try {
      await this.tail;
    } finally {
      await this.stop();
    }
    await this.preparing?.settled;
  }
}
