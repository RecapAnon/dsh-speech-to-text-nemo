// Speaks the real worker protocol (readiness line + authenticated HTTP) without native code.
import { startRecognitionServer } from '../../lib/process-server.js';
import { SpeechInputError } from '../../lib/models.js';

const config = JSON.parse(process.argv[2]);
const token = process.env.DSH_SPEECH_TOKEN;
if (config.failStartup) {
  process.stderr.write('model failed to load');
  process.exit(3);
}
if (config.startupDelayMs) await new Promise((resolve) => setTimeout(resolve, config.startupDelayMs));
const { port } = await startRecognitionServer(token, config.maxAudioBytes, (audio, language) => {
  if (language === 'xx') throw new SpeechInputError('Unsupported language: xx');
  if (language === 'crash') throw new Error('native failure');
  const until = Date.now() + (language === 'fr' ? 3000 : 0);
  while (Date.now() < until) { /* simulate long native inference */ }
  return { text: `${config.kind}:${language}:${audio.length}:${process.pid}`, audioSeconds: (audio.length - 44) / 32000, inferenceSeconds: 0.01 };
});
process.stdout.write(`${JSON.stringify({ port })}\n`);
