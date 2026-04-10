export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export default "soundscript";');
  return mod.default.slice(1, 5);
}
