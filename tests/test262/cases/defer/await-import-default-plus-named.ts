export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 22; export const value = 2;');
  return mod.default + mod.value;
}
