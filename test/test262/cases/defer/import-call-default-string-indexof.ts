export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default "banana";');
  return mod.default.indexOf('n');
}
