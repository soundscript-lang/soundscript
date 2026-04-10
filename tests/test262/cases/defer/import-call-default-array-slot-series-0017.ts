export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [17,18,19];');
  return mod.default[1];
}
