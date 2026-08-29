const CURRENT_FLASH_MODELS = Object.freeze([
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3.7-flash',
]);

const normalizeModelName = (value) => String(value || '')
  .trim()
  .replace(/^models\//, '');

export const getGeminiModelCandidates = ({ preferred = [] } = {}) => (
  [...new Set([
    ...(Array.isArray(preferred) ? preferred : [preferred]),
    ...CURRENT_FLASH_MODELS,
  ].map(normalizeModelName).filter(Boolean))]
);

export const formatGeminiAttemptFailures = (failures = []) => {
  if (!Array.isArray(failures) || failures.length === 0) return 'planning request timed out';
  return failures.map(({ model, error }) => {
    const message = String(error?.message || error || 'request failed')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    return `${normalizeModelName(model) || 'unknown model'}: ${message}`;
  }).join(' | ');
};

export { CURRENT_FLASH_MODELS };
