export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [8,9,10];');
  return mod.default[1];
}
