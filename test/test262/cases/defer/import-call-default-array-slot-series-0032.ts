export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [32,33,34];');
  return mod.default[1];
}
