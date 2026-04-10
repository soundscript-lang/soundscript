export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [22,23,24];');
  return mod.default[1];
}
