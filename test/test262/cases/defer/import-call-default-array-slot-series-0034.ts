export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [34,35,36];');
  return mod.default[1];
}
