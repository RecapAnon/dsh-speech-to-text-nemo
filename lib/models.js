/** Static facts about the two NeMo models; shared by the Host plugin and the worker process. */

/** Canary 180M Flash transcribes exactly these languages and cannot detect the language itself. */
export const CANARY_LANGUAGES = Object.freeze(['en', 'es', 'de', 'fr']);

/** The 25 languages listed on NVIDIA's Parakeet TDT 0.6B v3 model card, alphabetical. */
export const PARAKEET_LANGUAGE_CODES = Object.freeze([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it',
  'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk',
]);

/**
 * Parakeet detects the spoken language itself and takes no hint. It still advertises every code
 * (plus `auto`) so that switching to it from any provider/language never fails; the hint is ignored.
 */
export const PARAKEET_LANGUAGES = Object.freeze(['auto', ...PARAKEET_LANGUAGE_CODES]);

/** Native model files each kind needs, in assets.json key order. */
export const MODEL_FILES = Object.freeze({
  canary: Object.freeze(['encoder', 'decoder', 'tokens']),
  parakeet: Object.freeze(['encoder', 'decoder', 'joiner', 'tokens']),
});

/**
 * Per-model presentation and planning facts.
 * Memory figures: peak worker working set measured on Windows x64 with 2 threads
 * (Canary 588 MB, Parakeet 997 MB), rounded up.
 */
export const MODELS = Object.freeze({
  canary: Object.freeze({
    kind: 'canary',
    name: 'Canary 180M Flash (INT8)',
    defaultProviderId: 'canary-local',
    languages: CANARY_LANGUAGES,
    setupEstimate: Object.freeze({
      recommendedDiskBytes: 300e6,
      expectedMemoryBytes: 700e6,
      minimumMinutes: 1,
      maximumMinutes: 5,
    }),
  }),
  parakeet: Object.freeze({
    kind: 'parakeet',
    name: 'Parakeet TDT 0.6B v3 (INT8)',
    defaultProviderId: 'parakeet-local',
    languages: PARAKEET_LANGUAGES,
    setupEstimate: Object.freeze({
      recommendedDiskBytes: 800e6,
      expectedMemoryBytes: 1.2e9,
      minimumMinutes: 2,
      maximumMinutes: 15,
    }),
  }),
});

/** A request rejected before native inference; the loaded worker stays reusable. */
export class SpeechInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SpeechInputError';
  }
}
