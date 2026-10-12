/**
 * Diagnostic: how often does Canary return an empty segment with punctuation on, on real audio?
 * Runs the plugin's transcriber in-process, counting the punctuation-off retries.
 *
 *   node scripts/pnc-check.mjs [--root <dataRoot>]   (needs `npm run e2e` to have downloaded Canary and samples)
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Config } from '../lib/config.js';
import { createTranscriber } from '../lib/inference.js';
import { resolveRuntime } from '../lib/runtime.js';
import { encodeWave } from '../lib/wave.js';

const { values: args } = parseArgs({ options: { root: { type: 'string', default: resolve('.dev-cache/data') } } });
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const config = Config({ dataRoot: resolve(args.root) });
const { paths } = resolveRuntime(config, 'canary');

let retries = 0;
class Counting extends sherpa.OfflineRecognizer {
  setConfig(native) {
    if (native.modelConfig.canary.usePnc === 0) retries++;
    return super.setConfig(native);
  }
}
const workerConfig = {
  kind: 'canary', ...paths, threads: 2, segmentSeconds: 30, vadThreshold: 0.5, minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.5, segmentPaddingSeconds: 0.2, maxAudioBytes: 16 * 1024 * 1024, punctuation: true,
};
const transcribe = createTranscriber(workerConfig, { ...sherpa, OfflineRecognizer: Counting });

// The e2e script caches 16 kHz-convertible WAVs here; decode with sherpa's reader after resampling.
const samples = resolve('.dev-cache/samples');
const files = (await readdir(samples)).filter((name) => name.endsWith('.wav'));
let clips = 0;
let affected = 0;
for (const name of files) {
  const language = name.startsWith('minds14-es') ? 'es' : name.match(/^sample-(\w+)\.wav$/)?.[1];
  if (!['en', 'es', 'de', 'fr'].includes(language)) continue;
  const wave = decode(await readFile(join(samples, name)));
  const before = retries;
  const { text } = transcribe(encodeWave(wave), language);
  clips++;
  if (retries > before) {
    affected++;
    console.log(`retry on ${name}: ${text}`);
  }
}
console.log(`${clips} clips, ${affected} needed the punctuation-off retry (${retries} segments)`);

function decode(bytes) {
  const data = Buffer.from(bytes);
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { tag: data.readUInt16LE(offset + 8), channels: data.readUInt16LE(offset + 10), rate: data.readUInt32LE(offset + 12), bits: data.readUInt16LE(offset + 22) };
    if (id === 'data') pcm = data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  const frames = Math.floor(pcm.length / (format.channels * format.bits / 8));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const index = i * format.channels;
    if (format.tag === 7) {
      const u = ~pcm[index] & 0xff;
      const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
      out[i] = ((u & 0x80) ? -magnitude : magnitude) / 32768;
    } else {
      out[i] = pcm.readInt16LE(index * 2) / 32768;
    }
  }
  return format.rate === 16000 ? out : new sherpa.LinearResampler(format.rate, 16000).flush(out);
}
