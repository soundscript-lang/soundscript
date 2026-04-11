export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [26,27,28];');
  return mod.default[1];
}
