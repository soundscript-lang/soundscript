export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [16,17,18];');
  return mod.default[1];
}
