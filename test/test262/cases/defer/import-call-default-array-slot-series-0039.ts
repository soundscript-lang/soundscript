export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [39,40,41];');
  return mod.default[1];
}
