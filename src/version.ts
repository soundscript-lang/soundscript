export const VERSION = '0.1.40';

export function getSoundscriptToolFingerprint(): string {
  const override = Deno.env.get('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT');
  if (override) {
    return override;
  }

  return `${VERSION}:${new URL('.', import.meta.url).toString()}`;
}
