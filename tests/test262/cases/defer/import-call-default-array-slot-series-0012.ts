export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [12,13,14];');
  return mod.default[1];
}
