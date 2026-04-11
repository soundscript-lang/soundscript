export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [28,29,30];');
  return mod.default[1];
}
