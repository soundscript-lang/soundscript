export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export default 2; export const value = 3;');
  return `${Object.keys(mod).length}:${mod.default + mod.value}`;
}
