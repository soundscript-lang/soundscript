export async function main(): Promise<undefined> {
  const mod = await import('data:text/javascript,export default undefined;');
  return mod.default;
}
