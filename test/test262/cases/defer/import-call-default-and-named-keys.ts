export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 1; export const left = 2; export const right = 3;');
  return Object.keys(mod).length;
}
