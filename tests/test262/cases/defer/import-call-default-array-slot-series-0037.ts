export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [37,38,39];');
  return mod.default[1];
}
