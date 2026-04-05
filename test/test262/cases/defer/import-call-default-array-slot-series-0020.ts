export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [20,21,22];');
  return mod.default[1];
}
