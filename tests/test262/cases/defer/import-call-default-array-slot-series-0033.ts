export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [33,34,35];');
  return mod.default[1];
}
