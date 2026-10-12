/**
 * dsh-speech-to-text-nemo: registers local NVIDIA NeMo recognizers (Canary 180M Flash and
 * Parakeet TDT 0.6B v3) with the DSH speech service, the same way the official SenseVoice
 * provider does. Activation only inspects caches: nothing is downloaded or loaded until the
 * user prepares a recognizer in the voice settings.
 */
import { isAbsolute } from 'node:path';
import { Config } from './config.js';
import { MODELS } from './models.js';
import { NemoRecognizer } from './provider.js';

export { Config };
export const name = 'dsh-speech-to-text-nemo';
export const inject = ['speechToText', 'subprocess'];

/**
 * Public provider facts for one recognizer.
 * @param {object} config - validated config.
 * @param {'canary'|'parakeet'} kind - model kind.
 * @param {NemoRecognizer} recognizer - owner of preparation state.
 */
export function providerInfo(config, kind, recognizer) {
  const model = MODELS[kind];
  return {
    id: config[kind].providerId,
    name: model.name,
    location: 'host-local',
    languages: [...model.languages],
    downloadSources: recognizer.downloadSources,
    setupEstimate: { ...model.setupEstimate },
  };
}

/** Validate settings the schema cannot express. */
export function checkConfig(config) {
  for (const path of [config.dataRoot, config.vadModelPath, config.canary.modelDirectory, config.parakeet.modelDirectory]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`NeMo speech paths must be absolute: ${path}`);
  }
  for (const origin of config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]) new URL(origin);
  if (config.canary.enabled && config.parakeet.enabled && config.canary.providerId === config.parakeet.providerId) {
    throw new Error(`Canary and Parakeet need different provider ids: ${config.canary.providerId}`);
  }
}

/**
 * @param {object} ctx - Host context with the `speechToText` and `subprocess` services.
 * @param {object} config - validated configuration.
 * @param {object} [options] - test seam passed to each NemoRecognizer.
 */
export function apply(ctx, config, options) {
  checkConfig(config);
  for (const kind of Object.keys(MODELS)) {
    if (!config[kind].enabled) continue;
    const recognizer = new NemoRecognizer(ctx, config, kind, options);
    ctx.effect(() => {
      const unregister = ctx.speechToText.register({
        info: providerInfo(config, kind, recognizer),
        preparation: recognizer,
        transcribe: async (input, signal) => await recognizer.transcribe(input, signal),
      });
      recognizer.inspect();
      return async () => {
        const removing = unregister();
        await recognizer.dispose();
        await removing;
      };
    });
  }
}
