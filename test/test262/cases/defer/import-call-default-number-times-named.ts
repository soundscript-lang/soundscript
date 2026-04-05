export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default 6; export const factor = 5;');
  return mod.default * mod.factor;
}
