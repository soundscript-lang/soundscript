export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [38,39,40];');
  return mod.default[1];
}
