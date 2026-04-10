export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [19,20,21];');
  return mod.default[1];
}
