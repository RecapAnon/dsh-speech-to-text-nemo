/**
 * End-to-end check outside DSH: real plugin code, real downloads, real worker processes, real audio.
 *
 *   node scripts/e2e.mjs [--root <dataRoot>] [--only canary|parakeet] [--minds <n>] [--threads <n>]
 *
 * - Activates the plugin with a fake speech registry and a local stand-in for the subprocess service.
 * - Prepares each recognizer through the plugin (pinned downloads into <dataRoot>, hash verification).
 * - Transcribes the sherpa-onnx sample clips (en/es/de/fr) and Spanish phone calls from
 *   PolyAI/MINDS-14 (8 kHz mu-law, decoded and resampled here), plus a > 60 s concatenation.
 * - Reports word error rate against the dataset's reference transcriptions and peak worker memory.
 * Downloads are cached under .dev-cache/ (gitignored); pass --root to use another isolated root.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Config, apply } from '../lib/index.js';
import { encodeWave } from '../lib/wave.js';
import { createLocalSubprocess } from './local-subprocess.mjs';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: resolve('.dev-cache/data') },
    only: { type: 'string' },
    minds: { type: 'string', default: '20' },
    threads: { type: 'string', default: '2' },
  },
});
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const samplesRoot = resolve('.dev-cache/samples');
await mkdir(samplesRoot, { recursive: true });

// ---------- audio helpers ----------
function decodeWav(bytes) {
  const data = Buffer.from(bytes);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = data.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') pcm = body;
    offset += 8 + size + (size % 2);
  }
  if (!format || !pcm) throw new Error('WAV without fmt/data');
  const frames = Math.floor(pcm.length / (format.channels * format.bits / 8));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) {
      const index = i * format.channels + c;
      if (format.tag === 1 && format.bits === 16) sum += pcm.readInt16LE(index * 2) / 32768;
      else if (format.tag === 7 && format.bits === 8) sum += muLaw(pcm[index]);
      else if (format.tag === 3 && format.bits === 32) sum += pcm.readFloatLE(index * 4);
      else throw new Error(`unsupported WAV format ${format.tag}/${format.bits}`);
    }
    out[i] = sum / format.channels;
  }
  return { rate: format.rate, samples: out };
}

function muLaw(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return (sign ? -magnitude : magnitude) / 32768;
}

function to16k({ rate, samples }) {
  if (rate === 16000) return samples;
  return new sherpa.LinearResampler(rate, 16000).flush(samples);
}

async function cached(name, url) {
  const path = join(samplesRoot, name);
  try {
    await access(path);
    return await readFile(path);
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
    return bytes;
  }
}

// ---------- WER ----------
const words = (text) => text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
function wer(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return { errors: d[r.length][h.length], words: r.length };
}

// ---------- samples ----------
const PARAKEET_REPO = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78';
const clips = [];
for (const language of ['en', 'es', 'de', 'fr']) {
  const audio = to16k(decodeWav(await cached(`sample-${language}.wav`, `${PARAKEET_REPO}/test_wavs/${language}.wav`)));
  clips.push({ id: `sample-${language}`, language, audio });
}
const mindsCount = Number(args.minds);
if (mindsCount > 0) {
  const rowsPath = join(samplesRoot, `minds14-es-${mindsCount}.json`);
  let rows;
  try {
    rows = JSON.parse(await readFile(rowsPath, 'utf8'));
  } catch {
    const response = await fetch(`https://datasets-server.huggingface.co/rows?dataset=PolyAI/minds14&config=es-ES&split=train&offset=0&length=${mindsCount}`);
    rows = (await response.json()).rows.map(({ row_idx, row }) => ({ index: row_idx, src: row.audio[0].src, reference: row.transcription }));
    for (const row of rows) row.audio = (await cached(`minds14-es-${row.index}.wav`, row.src)).length;
    await writeFile(rowsPath, JSON.stringify(rows));
  }
  for (const row of rows) {
    const audio = to16k(decodeWav(await readFile(join(samplesRoot, `minds14-es-${row.index}.wav`))));
    clips.push({ id: `minds14-es-${row.index}`, language: 'es', audio, reference: row.reference });
  }
}
const long = clips.filter((clip) => clip.id.startsWith('minds14')).slice(0, 8);
if (long.length > 0) {
  const gap = new Float32Array(16000);
  const parts = long.flatMap((clip) => [clip.audio, gap]);
  const audio = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    audio.set(part, at);
    at += part.length;
  }
  clips.push({ id: 'minds14-es-long', language: 'es', audio, reference: long.map((clip) => clip.reference).join(' ') });
}

// ---------- plugin ----------
const subprocess = createLocalSubprocess();
const providers = new Map();
const disposers = [];
const ctx = {
  subprocess,
  logger: console,
  effect(fn) {
    disposers.push(fn());
  },
  speechToText: {
    register(provider) {
      providers.set(provider.info.id, provider);
      return async () => providers.delete(provider.info.id);
    },
  },
};
const config = Config({
  dataRoot: resolve(args.root),
  threads: Number(args.threads),
  idleTimeoutMs: 0,
  canary: { enabled: args.only !== 'parakeet' },
  parakeet: { enabled: args.only !== 'canary' },
});
apply(ctx, config);

function settle(provider, phases) {
  return new Promise((done) => {
    let lastLog = 0;
    const check = () => {
      const state = provider.preparation.snapshot();
      if (state.phase === 'downloading' && Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.log(`  ${provider.info.id}: ${state.resource} ${(state.completedBytes / 1e6).toFixed(0)}/${(state.totalBytes / 1e6).toFixed(0)} MB`);
      }
      if (phases.includes(state.phase)) {
        unsubscribe();
        done(state);
      }
    };
    const unsubscribe = provider.preparation.subscribe(check);
    check();
  });
}

const peakMemory = (pid) => {
  try {
    return Number(execFileSync('pwsh', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: 'utf8' }).trim());
  } catch {
    return NaN;
  }
};

const summary = [];
for (const provider of providers.values()) {
  console.log(`\n=== ${provider.info.id} (${provider.info.name}) languages=${provider.info.languages.join(',')}`);
  const inspected = await settle(provider, ['standby', 'unprepared', 'failed']);
  console.log(`  after activation: ${inspected.phase}`);
  const started = performance.now();
  provider.preparation.prepare();
  const prepared = await settle(provider, ['ready', 'failed', 'cancelled']);
  console.log(`  prepare: ${prepared.phase} in ${((performance.now() - started) / 1000).toFixed(1)} s${prepared.message ? ` — ${prepared.message}` : ''}`);
  if (prepared.phase !== 'ready') {
    summary.push({ provider: provider.info.id, failed: prepared.message });
    continue;
  }
  let errors = 0;
  let total = 0;
  let audioSeconds = 0;
  let inferenceSeconds = 0;
  const empty = [];
  for (const clip of clips) {
    if (!provider.info.languages.includes(clip.language)) continue;
    const wav = encodeWave(clip.audio);
    const result = await provider.transcribe({ audio: wav, language: clip.language }, AbortSignal.timeout(300_000));
    audioSeconds += result.audioSeconds;
    inferenceSeconds += result.inferenceSeconds;
    if (!result.text) empty.push(clip.id);
    let score = '';
    if (clip.reference && clip.id !== 'minds14-es-long') {
      const { errors: e, words: w } = wer(clip.reference, result.text);
      errors += e;
      total += w;
      score = ` WER ${(100 * e / w).toFixed(0)}%`;
    } else if (clip.reference) {
      const { errors: e, words: w } = wer(clip.reference, result.text);
      score = ` WER ${(100 * e / w).toFixed(0)}% (long, not in total)`;
    }
    console.log(`  [${clip.id} ${result.audioSeconds.toFixed(1)}s → ${result.inferenceSeconds.toFixed(2)}s${score}] ${result.text}`);
  }
  // Same clip twice and a language switch: results must not depend on earlier requests.
  const repeat = clips.find((clip) => clip.id === 'sample-es');
  const language = provider.info.languages.includes('es') ? 'es' : provider.info.languages[0];
  const first = await provider.transcribe({ audio: encodeWave(repeat.audio), language }, AbortSignal.timeout(60_000));
  if (provider.info.languages.includes('en')) await provider.transcribe({ audio: encodeWave(clips[0].audio), language: 'en' }, AbortSignal.timeout(60_000));
  const second = await provider.transcribe({ audio: encodeWave(repeat.audio), language }, AbortSignal.timeout(60_000));
  console.log(`  repeat stable: ${first.text === second.text}`);
  // An unsupported language is rejected before inference and the worker survives.
  const rejected = await provider.transcribe({ audio: encodeWave(repeat.audio), language: 'xx' }, AbortSignal.timeout(60_000)).then(() => 'accepted', (error) => error.constructor.name);
  const after = await provider.transcribe({ audio: encodeWave(repeat.audio), language }, AbortSignal.timeout(60_000));
  console.log(`  unsupported language → ${rejected}; worker still answers: ${after.text === first.text}`);
  const pid = [...subprocess.children].at(-1)?.pid;
  const memory = pid ? peakMemory(pid) : NaN;
  console.log(`  MINDS-14 WER ${total ? (100 * errors / total).toFixed(1) : '-'}% over ${total} words; RTF ${(inferenceSeconds / audioSeconds).toFixed(3)}; peak worker memory ${(memory / 1e6).toFixed(0)} MB; empty: ${empty.join(',') || 'none'}`);
  summary.push({ provider: provider.info.id, wer: total ? +(100 * errors / total).toFixed(1) : null, rtf: +(inferenceSeconds / audioSeconds).toFixed(3), peakMB: Math.round(memory / 1e6), empty, repeatStable: first.text === second.text, rejected });
}

for (const dispose of disposers) await dispose();
console.log(`\nworkers left running: ${subprocess.children.size}`);
console.log(JSON.stringify(summary, null, 2));
