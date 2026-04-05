export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [6,7,8];');
  return mod.default[1];
}
