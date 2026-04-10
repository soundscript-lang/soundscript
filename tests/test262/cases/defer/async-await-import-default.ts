export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 13;');
  return mod.default;
}
