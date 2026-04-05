export async function main(): Promise<null> {
  const mod = await import('data:text/javascript,export default null;');
  return mod.default;
}
