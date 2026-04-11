export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [27,28,29];');
  return mod.default[1];
}
