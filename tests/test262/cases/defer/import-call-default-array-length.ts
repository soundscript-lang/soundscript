export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default [1,2,3];');
  return mod.default.length;
}
