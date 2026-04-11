export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 21; export const value = 1;');
  return mod.default + mod.value;
}
