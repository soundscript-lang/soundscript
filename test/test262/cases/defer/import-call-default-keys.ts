export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 12;');
  return Object.keys(mod).length;
}
