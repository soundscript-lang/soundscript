export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [2,3,4];');
  return mod.default[1];
}
