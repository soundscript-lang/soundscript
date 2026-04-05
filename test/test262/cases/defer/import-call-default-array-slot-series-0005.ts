export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [5,6,7];');
  return mod.default[1];
}
