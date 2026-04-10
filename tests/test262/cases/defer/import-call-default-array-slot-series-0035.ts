export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [35,36,37];');
  return mod.default[1];
}
