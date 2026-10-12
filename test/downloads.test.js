import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Config } from '../lib/config.js';
import {
  SpeechDownloadError, classifyDownloadFailure, downloadAsset, matchesAsset, orderModelSources,
} from '../lib/downloads.js';
import { inspectRuntime, prepareRuntime, readAssetLock, removePartials, resolveRuntime } from '../lib/runtime.js';

const payload = Buffer.from('pinned model bytes '.repeat(1000));
const sha256 = createHash('sha256').update(payload).digest('hex');
const asset = (url, overrides = {}) => ({ name: 'model.onnx', url, bytes: payload.length, sha256, ...overrides });

let server;
let origin;
let mirror;
let mirrorServer;
const hits = [];
let root;

/** `/good/*` serves the payload, `/bad/*` serves corrupted bytes, `/long/*` too many bytes, anything else 404. */
function handler(name) {
  return (request, response) => {
    hits.push(`${name} ${request.method} ${request.url}`);
    const path = new URL(request.url, 'http://x').pathname;
    if (path.startsWith('/good/')) {
      response.writeHead(200, { 'content-length': payload.length });
      response.end(request.method === 'HEAD' ? undefined : payload);
    } else if (path.startsWith('/bad/')) {
      const bad = Buffer.from(payload);
      bad[10] ^= 1;
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : bad);
    } else if (path.startsWith('/long/')) {
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : Buffer.concat([payload, Buffer.from('x')]));
    } else {
      response.writeHead(404).end();
    }
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'nemo-dl-'));
  server = createServer(handler('primary'));
  mirrorServer = createServer(handler('mirror'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => mirrorServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  mirror = `http://127.0.0.1:${mirrorServer.address().port}`;
});

after(async () => {
  server.close();
  mirrorServer.close();
  await rm(root, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(10_000);

test('a verified download is published under its name and reported with byte progress', async () => {
  const dir = join(root, 'ok');
  const reports = [];
  const path = await downloadAsset(asset(`${origin}/good/model.onnx`), dir, signal(), (state) => reports.push(state));
  assert.deepEqual(await readFile(path), payload);
  assert.equal(reports.at(-1).completedBytes, payload.length);
  assert.equal(reports.at(-1).totalBytes, payload.length);
  assert.deepEqual(await readdir(dir), ['model.onnx'], 'no partial files left behind');
  assert.equal(await matchesAsset(path, asset(''), signal()), true);
});

test('wrong hash, oversize, and HTTP failures are rejected without publishing a file', async () => {
  const cases = [
    ['bad', 'integrity'],
    ['long', 'integrity'],
    ['missing', 'http'],
  ];
  for (const [kind, reason] of cases) {
    const dir = join(root, kind);
    await assert.rejects(downloadAsset(asset(`${origin}/${kind}/model.onnx`), dir, signal()), (error) => {
      assert.ok(error instanceof SpeechDownloadError);
      assert.equal(error.download.reason, reason);
      assert.equal(error.download.source, origin);
      return true;
    });
    assert.deepEqual(await readdir(dir), [], `${kind}: nothing published`);
  }
});

test('an existing file with the right size but wrong content does not match', async () => {
  const dir = join(root, 'tampered');
  await mkdir(dir, { recursive: true });
  const bad = Buffer.from(payload);
  bad[0] ^= 1;
  await writeFile(join(dir, 'model.onnx'), bad);
  assert.equal(await matchesAsset(join(dir, 'model.onnx'), asset(''), signal()), false);
  assert.equal(await matchesAsset(join(dir, 'absent.onnx'), asset(''), signal()), false);
  // downloadAsset replaces it with the verified copy.
  await downloadAsset(asset(`${origin}/good/model.onnx`), dir, signal());
  assert.deepEqual(await readFile(join(dir, 'model.onnx')), payload);
});

test('source ordering prefers the first origin that answers, and keeps the others', async () => {
  const urls = await orderModelSources('https://huggingface.co/good/a.onnx', ['http://127.0.0.1:1', mirror], 2000, signal());
  assert.deepEqual(urls, [`${mirror}/good/a.onnx`, 'http://127.0.0.1:1/good/a.onnx']);
  assert.deepEqual(await orderModelSources('https://huggingface.co/x', [origin], 2000, signal()), [`${origin}/x`]);
});

test('classification maps network codes and never leaks messages', () => {
  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND secret.host'), { code: 'ENOTFOUND' }) });
  assert.deepEqual(classifyDownloadFailure(dns), { reason: 'dns', code: 'ENOTFOUND' });
  assert.deepEqual(classifyDownloadFailure(new TypeError('fetch failed')), { reason: 'network' });
  assert.deepEqual(classifyDownloadFailure(Object.assign(new Error('x'), { code: 'ENOSPC' })), { reason: 'storage', code: 'ENOSPC' });
  assert.deepEqual(classifyDownloadFailure(new Error('weird')), { reason: 'unknown' });
});

/** Point the shipped lock at the local servers, keeping the pinned identities' shape. */
function testConfig(dataRoot, origins) {
  return Config({ dataRoot, modelOrigins: origins, modelProbeTimeoutMs: 1000 });
}

test('pinned assets: every file has a revision-pinned Hugging Face URL, a size and a SHA-256', () => {
  const lock = readAssetLock();
  const all = [lock.vad, ...Object.values(lock.models).flatMap((model) => Object.values(model.files))];
  for (const item of all) {
    assert.match(item.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//, item.url);
    assert.ok(item.url.endsWith(`/${item.name}`));
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(Object.keys(lock.models.canary.files), ['encoder', 'decoder', 'tokens']);
  assert.deepEqual(Object.keys(lock.models.parakeet.files), ['encoder', 'decoder', 'joiner', 'tokens']);
});

test('runtime paths: managed directories under dataRoot; explicit directories are unmanaged', () => {
  const config = Config({ dataRoot: join(root, 'data') });
  const canary = resolveRuntime(config, 'canary');
  assert.equal(canary.paths.encoder, join(root, 'data', 'models', 'canary-180m-flash-en-es-de-fr-int8', 'encoder.int8.onnx'));
  assert.equal(canary.paths.vad, join(root, 'data', 'models', 'silero', 'silero_vad.onnx'));
  assert.equal(canary.paths.joiner, undefined);
  assert.equal(canary.managed.length, 4);
  const offline = resolveRuntime(Config({ dataRoot: root, parakeet: { modelDirectory: 'D:\\models\\p' }, vadModelPath: 'D:\\vad.onnx' }), 'parakeet');
  assert.equal(offline.paths.joiner, join('D:\\models\\p', 'joiner.int8.onnx'));
  assert.equal(offline.paths.vad, 'D:\\vad.onnx');
  assert.deepEqual(offline.managed, []);
});

test('prepareRuntime falls through to the next origin after an integrity failure', async () => {
  const lock = readAssetLock();
  // Serve fake files whose identity matches a rewritten lock: use the real lock's paths but our payload.
  const fakeLock = structuredClone(lock);
  for (const item of [fakeLock.vad, ...Object.values(fakeLock.models.canary.files)]) Object.assign(item, { bytes: payload.length, sha256 });
  const dataRoot = join(root, 'prepare');
  const config = testConfig(dataRoot, [origin, mirror]);
  // The primary serves corrupted bytes for every path; the mirror serves good bytes.
  const corrupt = createServer(handler('corrupt'));
  await new Promise((resolve) => corrupt.listen(0, '127.0.0.1', resolve));
  const goodMirror = createServer((request, response) => {
    hits.push(`goodMirror ${request.method} ${request.url}`);
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : payload);
  });
  await new Promise((resolve) => goodMirror.listen(0, '127.0.0.1', resolve));
  const badOrigin = `http://127.0.0.1:${corrupt.address().port}`;
  const goodOrigin = `http://127.0.0.1:${goodMirror.address().port}`;
  // Rewrite URLs so the primary answers /bad/... (HEAD 200, corrupted body).
  for (const item of [fakeLock.vad, ...Object.values(fakeLock.models.canary.files)]) {
    item.url = `https://huggingface.co/bad/${item.name}`;
  }
  try {
    const steps = [];
    const paths = await prepareRuntime({ ...config, modelOrigins: [badOrigin, goodOrigin] }, 'canary', AbortSignal.timeout(10_000),
      (state) => steps.push(state.step), () => false, fakeLock);
    assert.deepEqual(await readFile(paths.encoder), payload);
    assert.deepEqual(await readFile(paths.vad), payload);
    assert.ok(steps.includes('model') && steps.includes('vad') && steps.at(-1) === 'verify');
    assert.ok(hits.some((hit) => hit.startsWith('corrupt GET /bad/encoder.int8.onnx')), 'first responder tried first');
    assert.ok(hits.some((hit) => hit.startsWith('goodMirror GET /bad/encoder.int8.onnx')), 'mirror used after integrity failure');
    assert.deepEqual(await inspectRuntime({ ...config, modelOrigins: [badOrigin] }, 'canary', signal(), fakeLock), paths);
  } finally {
    corrupt.close();
    goodMirror.close();
  }
});

test('inspectRuntime reports missing files without downloading', async () => {
  const config = Config({ dataRoot: join(root, 'empty'), modelOrigins: ['http://127.0.0.1:1'] });
  assert.equal(await inspectRuntime(config, 'parakeet', signal()), undefined);
  assert.equal(typeof prepareRuntime, 'function');
});

test('stale partial downloads are removed; recent ones in shared directories are kept', async () => {
  const dir = join(root, 'partials');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'a.onnx.1.part'), 'x');
  await writeFile(join(dir, 'keep.onnx'), 'x');
  assert.equal(await removePartials(dir, 60_000), 0, 'recent partials kept');
  assert.equal(await removePartials(dir, 0), 1);
  assert.deepEqual(await readdir(dir), ['keep.onnx']);
  assert.equal(await removePartials(join(root, 'absent'), 0), 0);
});