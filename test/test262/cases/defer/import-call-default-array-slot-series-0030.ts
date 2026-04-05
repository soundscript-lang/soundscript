export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [30,31,32];');
  return mod.default[1];
}
