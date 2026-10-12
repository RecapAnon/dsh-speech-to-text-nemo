/**
 * Pinned, verified model downloads from Hugging Face-compatible origins.
 *
 * Every file is identified by a revision-pinned URL, an exact byte size, and a SHA-256 digest.
 * Downloads stream into a unique partial file, are verified, and are then renamed into place.
 * Failures surface as {@link SpeechDownloadError} whose public details exclude raw causes,
 * credentials, query strings and local paths, matching the official speech UI's expectations.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Error codes mapped to the failure reasons the speech UI understands. */
const codes = [
  ['dns', /^(ENOTFOUND|EAI_AGAIN)$/],
  ['timeout', /^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/],
  ['certificate', /^(CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/],
  ['storage', /^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/],
  ['network', /^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/],
];

/**
 * Bound an operation by a deadline in addition to its caller's signal.
 * @param {AbortSignal} signal - caller cancellation.
 * @param {number} ms - maximum duration.
 * @param {string} code - diagnostic code carried by the timeout reason.
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, [Symbol.dispose]: () => void }}
 */
export function deadline(signal, ms, code) {
  const timer = new AbortController();
  const handle = setTimeout(() => {
    const reason = new Error(`Operation timed out (${code})`);
    reason.name = 'TimeoutError';
    reason.code = code;
    timer.abort(reason);
  }, ms);
  handle.unref?.();
  return {
    signal: AbortSignal.any([signal, timer.signal]),
    timedOut: () => timer.signal.aborted,
    [Symbol.dispose]: () => clearTimeout(handle),
  };
}

/**
 * Inspect fetch failures, including aggregate connection attempts, without publishing their messages.
 * @param {unknown} failure - error received from the network or filesystem.
 * @returns {{ reason: string, code?: string }} an actionable category and recognised diagnostic code.
 */
export function classifyDownloadFailure(failure) {
  const pending = [failure];
  const visited = new Set();
  let reason = 'unknown';
  while (pending.length > 0) {
    const error = pending.shift();
    if (!(error instanceof Error) || visited.has(error)) continue;
    visited.add(error);
    if (error.name === 'TimeoutError') return { reason: 'timeout' };
    if (typeof error.code === 'string') {
      for (const [kind, pattern] of codes) if (pattern.test(error.code)) return { reason: kind, code: error.code };
    }
    if (error instanceof TypeError && error.message === 'fetch failed') reason = 'network';
    pending.push(error.cause);
    if (error instanceof AggregateError) pending.push(...error.errors);
  }
  return { reason };
}

/** A preparation failure whose public `download` details are safe to show in the UI. */
export class SpeechDownloadError extends Error {
  /**
   * @param {{ resource: string, source: string, reason: string, code?: string, status?: number }} download
   * @param {ErrorOptions} [options]
   */
  constructor(download, options) {
    super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}`
      + `${download.code ? ` (${download.code})` : ''}${download.status === undefined ? '' : ` (HTTP ${download.status})`}`, options);
    this.name = 'SpeechDownloadError';
    this.download = download;
  }
}

/**
 * Prefer the first origin that answers a HEAD request, keeping the others for fallback.
 * @param {string} assetUrl - revision-pinned upstream file URL.
 * @param {readonly string[]} origins - nonempty configured origins.
 * @param {number} timeoutMs - maximum probe duration.
 * @param {AbortSignal} signal - preparation cancellation.
 * @returns {Promise<string[]>} deduplicated URLs, first responder first; configured order when none respond.
 */
export async function orderModelSources(assetUrl, origins, timeoutMs, signal) {
  signal.throwIfAborted();
  const path = new URL(assetUrl).pathname;
  const urls = [...new Set(origins.map((origin) => new URL(path, origin).href))];
  if (urls.length === 1) return urls;
  const timeout = deadline(signal, timeoutMs, 'SPEECH_SOURCE_PROBE_TIMEOUT');
  const finished = new AbortController();
  const probing = AbortSignal.any([timeout.signal, finished.signal]);
  const requests = urls.map(async (url) => ({ url, response: await fetch(url, { method: 'HEAD', signal: probing }) }));
  let preferred;
  try {
    preferred = await Promise.any(requests.map(async (request) => {
      const { url, response } = await request;
      if (!response.ok) throw new Error(`Model source probe returned HTTP ${response.status}`);
      return url;
    }));
  } catch {
    // Every probe failed: keep the configured order and let downloads report the real error.
  } finally {
    finished.abort();
    timeout[Symbol.dispose]();
    const settled = await Promise.allSettled(requests);
    await Promise.allSettled(settled.map(async (result) => {
      if (result.status === 'fulfilled') await result.value.response.body?.cancel();
    }));
  }
  signal.throwIfAborted();
  return preferred === undefined ? urls : [preferred, ...urls.filter((url) => url !== preferred)];
}

/**
 * Check a local file against its pinned size and SHA-256.
 * @param {string} path - candidate file.
 * @param {{ bytes: number, sha256: string }} asset - pinned identity.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} true only for an exact match; missing files return false.
 */
export async function matchesAsset(path, asset, signal) {
  signal.throwIfAborted();
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`);
    if (info.size !== asset.bytes) return false;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
    return digest.digest('hex') === asset.sha256;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
}

/**
 * Download one pinned file into `root`, verifying size and hash before publishing it.
 * @param {{ name: string, url: string, bytes: number, sha256: string }} asset - pinned identity and source URL.
 * @param {string} root - destination directory.
 * @param {AbortSignal} signal - preparation cancellation (and deadline).
 * @param {(state: object) => void} [report] - progress publisher.
 * @param {() => boolean} [timedOut] - whether `signal` fired because of a deadline.
 * @returns {Promise<string>} verified local path.
 */
export async function downloadAsset(asset, root, signal, report = () => {}, timedOut = () => false) {
  signal.throwIfAborted();
  const destination = join(root, asset.name);
  const partial = `${destination}.${randomUUID()}.part`;
  let source = new URL(asset.url).origin;
  try {
    await mkdir(root, { recursive: true });
    if (await matchesAsset(destination, asset, signal)) return destination;
    try {
      const response = await fetch(asset.url, { signal });
      source = new URL(response.url || asset.url).origin;
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'http', status: response.status });
      }
      const digest = createHash('sha256');
      let completedBytes = 0;
      const publish = () => report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes });
      publish();
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          completedBytes += chunk.length;
          if (completedBytes > asset.bytes) {
            callback(new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' }));
            return;
          }
          digest.update(chunk);
          publish();
          callback(null, chunk);
        },
      });
      await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
      if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) {
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' });
      }
      signal.throwIfAborted();
      try {
        await rename(partial, destination);
      } catch (error) {
        // Another provider may have published the same shared file (the VAD model) concurrently.
        if (!await matchesAsset(destination, asset, signal)) throw error;
      }
      return destination;
    } finally {
      await rm(partial, { force: true });
    }
  } catch (error) {
    const expired = timedOut();
    if ((signal.aborted && !expired) || error instanceof SpeechDownloadError) throw error;
    throw new SpeechDownloadError({
      resource: asset.name,
      source,
      ...(expired ? { reason: 'timeout' } : classifyDownloadFailure(error)),
    }, { cause: error });
  }
}
