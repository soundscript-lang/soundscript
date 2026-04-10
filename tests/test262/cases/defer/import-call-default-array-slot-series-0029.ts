export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [29,30,31];');
  return mod.default[1];
}
