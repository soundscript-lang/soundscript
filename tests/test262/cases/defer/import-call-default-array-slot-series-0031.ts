export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [31,32,33];');
  return mod.default[1];
}
