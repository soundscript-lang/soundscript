export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [24,25,26];');
  return mod.default[1];
}
