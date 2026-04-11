export async function main(): Promise<boolean> {
  const mod = await import('data:text/javascript,export default true;');
  return mod.default;
}
