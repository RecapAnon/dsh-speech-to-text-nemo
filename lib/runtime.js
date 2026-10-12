/** Model locations, cache inspection, and on-demand preparation for one recognizer kind. */
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeechDownloadError, downloadAsset, matchesAsset, orderModelSources } from './downloads.js';
import { MODEL_FILES } from './models.js';

const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

/** @returns {object} the pinned asset lock shipped with the package. */
export function readAssetLock() {
  return JSON.parse(readFileSync(new URL('../runtime/assets.json', import.meta.url), 'utf8'));
}

/**
 * Resolve every path one recognizer needs.
 * @param {object} config - validated plugin config.
 * @param {'canary'|'parakeet'} kind - recognizer kind.
 * @param {object} [lock] - asset lock; defaults to runtime/assets.json.
 * @returns {{ lock: object, modelRoot: string, vadRoot: string, paths: Record<string, string>, managed: Array<[string, object]> }}
 */
export function resolveRuntime(config, kind, lock = readAssetLock()) {
  if (!SUPPORTED_PLATFORMS.includes(`${process.platform}-${process.arch}`)) {
    throw new Error(`Local speech is unavailable for ${process.platform}-${process.arch}`);
  }
  const entry = lock.models[kind];
  const settings = config[kind];
  const modelRoot = settings.modelDirectory ?? join(config.dataRoot, 'models', entry.directory);
  const vadRoot = join(config.dataRoot, 'models', 'silero');
  const paths = {};
  for (const file of MODEL_FILES[kind]) paths[file] = join(modelRoot, entry.files[file].name);
  paths.vad = config.vadModelPath ?? join(vadRoot, lock.vad.name);
  paths.worker = fileURLToPath(new URL('./worker.js', import.meta.url));
  const managed = [
    ...(settings.modelDirectory === undefined ? MODEL_FILES[kind].map((file) => [paths[file], entry.files[file]]) : []),
    ...(config.vadModelPath === undefined ? [[paths.vad, lock.vad]] : []),
  ];
  return { lock, modelRoot, vadRoot, paths, managed };
}

async function verifyRuntime(runtime, signal) {
  signal.throwIfAborted();
  try {
    await Promise.all(Object.entries(runtime.paths).map(([, path]) => access(path)));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
  for (const [path, asset] of runtime.managed) if (!await matchesAsset(path, asset, signal)) return false;
  signal.throwIfAborted();
  return true;
}

/**
 * Inspect caches without downloading, writing files, or starting a worker.
 * @returns {Promise<Record<string, string>|undefined>} verified paths, or undefined when anything is missing or wrong.
 */
export async function inspectRuntime(config, kind, signal, lock = readAssetLock()) {
  const runtime = resolveRuntime(config, kind, lock);
  return await verifyRuntime(runtime, signal) ? runtime.paths : undefined;
}

/**
 * Download missing or corrupted managed files, then verify everything.
 * @param {object} config - validated config; `modelOrigin` set means a single source without fallback.
 * @param {'canary'|'parakeet'} kind - recognizer kind.
 * @param {AbortSignal} signal - preparation cancellation or deadline.
 * @param {(state: object) => void} report - progress publisher.
 * @param {() => boolean} [timedOut] - whether `signal` fired because of a deadline.
 * @param {object} [lock] - asset lock; defaults to runtime/assets.json.
 * @returns {Promise<Record<string, string>>} verified paths.
 */
export async function prepareRuntime(config, kind, signal, report = () => {}, timedOut = () => false, lock = readAssetLock()) {
  const runtime = resolveRuntime(config, kind, lock);
  const { modelRoot, vadRoot, paths } = runtime;
  const origins = config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin];
  const download = async (asset, root, step) => {
    if (await matchesAsset(join(root, asset.name), asset, signal)) return;
    const urls = await orderModelSources(asset.url, origins, config.modelProbeTimeoutMs, signal);
    for (const [index, url] of urls.entries()) {
      try {
        await downloadAsset({ ...asset, url }, root, signal, (state) => report({ ...state, step }), timedOut);
        return;
      } catch (error) {
        const final = signal.aborted || !(error instanceof SpeechDownloadError)
          || error.download.reason === 'storage' || error.download.reason === 'unknown' || index === urls.length - 1;
        if (final) throw error;
      }
    }
  };
  if (config[kind].modelDirectory === undefined) {
    report({ phase: 'checking', step: 'model', startedAt: Date.now() });
    for (const file of MODEL_FILES[kind]) await download(lock.models[kind].files[file], modelRoot, 'model');
  }
  if (config.vadModelPath === undefined) {
    report({ phase: 'checking', step: 'vad', startedAt: Date.now() });
    await download(lock.vad, vadRoot, 'vad');
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() });
  if (!await verifyRuntime(runtime, signal)) throw new Error('Speech model verification failed: missing or corrupted model files');
  return paths;
}
