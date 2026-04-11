export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [3,4,5];');
  return mod.default[1];
}
