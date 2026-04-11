export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [10,11,12];');
  return mod.default[1];
}
