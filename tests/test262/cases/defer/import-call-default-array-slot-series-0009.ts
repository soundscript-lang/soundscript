export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [9,10,11];');
  return mod.default[1];
}
