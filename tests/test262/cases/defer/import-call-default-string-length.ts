export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default "hello";');
  return mod.default.length;
}
