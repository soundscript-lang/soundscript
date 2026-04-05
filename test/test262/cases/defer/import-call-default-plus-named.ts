export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 4; export const extra = 5;');
  return mod.default + mod.extra;
}
