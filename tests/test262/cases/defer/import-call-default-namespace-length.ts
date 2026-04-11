export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 8;');
  return Object.keys(mod).length;
}
