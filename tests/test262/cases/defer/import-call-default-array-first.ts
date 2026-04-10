export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [7,8,9];');
  return mod.default[0];
}
