/** Canonical WAV handling for recordings delivered by the DSH speech service. */

/**
 * Validate a canonical 16 kHz mono PCM16 WAV (44-byte header), rejecting inconsistent lengths.
 * Mirrors the check the speech service performs before it calls a provider.
 * @param {Uint8Array} audio - request bytes.
 * @param {number} maxDurationSeconds - longest admitted recording.
 * @returns {number} recording duration in seconds.
 */
export function validateWave(audio, maxDurationSeconds) {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (data.length < 46 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE' || data.toString('ascii', 12, 16) !== 'fmt '
    || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000
    || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16
    || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2 !== 0) {
    throw new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording');
  }
  const seconds = (data.length - 44) / 32000;
  if (seconds > maxDurationSeconds) throw new Error(`Audio exceeds ${maxDurationSeconds} seconds`);
  return seconds;
}

/**
 * Convert the PCM16 payload of a validated canonical WAV to float samples in [-1, 1).
 * @param {Uint8Array} audio - validated WAV bytes.
 * @returns {Float32Array}
 */
export function wavSamples(audio) {
  const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
  return samples;
}

/**
 * Encode float samples as a canonical 16 kHz mono PCM16 WAV (used by tests and the E2E script).
 * @param {Float32Array} samples - mono samples at 16 kHz.
 * @returns {Buffer}
 */
export function encodeWave(samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0, 'ascii');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVE', 8, 'ascii');
  data.write('fmt ', 12, 'ascii');
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36, 'ascii');
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + i * 2);
  }
  return data;
}
