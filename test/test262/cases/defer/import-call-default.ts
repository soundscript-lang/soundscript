export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 9;');
  return mod.default;
}
