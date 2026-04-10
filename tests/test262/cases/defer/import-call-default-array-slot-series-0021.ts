export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [21,22,23];');
  return mod.default[1];
}
