export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [18,19,20];');
  return mod.default[1];
}
