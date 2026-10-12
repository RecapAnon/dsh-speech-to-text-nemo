/** Authenticated loopback HTTP transport for one serial native recognizer. */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { SpeechInputError } from './models.js';

/**
 * Bind an ephemeral loopback listener. The model is loaded before this is called,
 * so publishing the port means the worker is ready.
 * @param {string} token - per-process bearer secret.
 * @param {number} maxAudioBytes - largest accepted request body.
 * @param {(audio: Buffer, language: string) => object} transcribe - synchronous inference.
 * @returns {Promise<{ server: import('node:http').Server, port: number }>}
 */
export async function startRecognitionServer(token, maxAudioBytes, transcribe) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume();
      reply(401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume();
      reply(404, { error: 'Unknown endpoint' });
      return;
    }
    const length = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
      request.resume();
      reply(413, { error: 'Invalid speech audio size', code: 'invalid-input' });
      return;
    }
    (async () => {
      try {
        const chunks = [];
        let received = 0;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit');
          chunks.push(chunk);
        }
        reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get('language') ?? ''));
      } catch (error) {
        const input = error instanceof SpeechInputError;
        reply(input ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...(input ? { code: 'invalid-input' } : {}),
        });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, port: server.address().port };
}
