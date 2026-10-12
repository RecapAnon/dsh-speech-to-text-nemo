/**
 * Private child-process entry. The Host owns its lifetime; stdout carries only the readiness line.
 * argv[2] is the JSON worker config built by the Host; DSH_SPEECH_TOKEN carries the bearer secret.
 */
import { createRequire } from 'node:module';
import { createTranscriber, parseWorkerConfig } from './inference.js';
import { startRecognitionServer } from './process-server.js';

const config = parseWorkerConfig(JSON.parse(process.argv[2] ?? 'null'));
const token = process.env.DSH_SPEECH_TOKEN ?? '';
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Speech worker token is missing');
delete process.env.DSH_SPEECH_TOKEN;
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const { port } = await startRecognitionServer(token, config.maxAudioBytes, createTranscriber(config, sherpa));
process.stdout.write(`${JSON.stringify({ port })}\n`);
