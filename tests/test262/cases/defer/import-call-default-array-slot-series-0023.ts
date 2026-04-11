export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [23,24,25];');
  return mod.default[1];
}
