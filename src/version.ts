export const VERSION = '0.1.29';

export function getSoundscriptToolFingerprint(): string {
  const override = Deno.env.get('SOUNDSCRIPT_CACHE_TOOL_FINGERPRINT');
  if (override) {
    return override;
  }

  return `${VERSION}:${new URL('.', import.meta.url).toString()}`;
}
