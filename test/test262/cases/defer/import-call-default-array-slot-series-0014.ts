export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [14,15,16];');
  return mod.default[1];
}
