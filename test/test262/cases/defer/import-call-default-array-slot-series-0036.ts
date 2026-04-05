export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [36,37,38];');
  return mod.default[1];
}
