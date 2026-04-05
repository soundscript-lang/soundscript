export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [25,26,27];');
  return mod.default[1];
}
