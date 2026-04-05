export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [15,16,17];');
  return mod.default[1];
}
