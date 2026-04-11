export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [13,14,15];');
  return mod.default[1];
}
