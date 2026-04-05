export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [4,5,6];');
  return mod.default[1];
}
