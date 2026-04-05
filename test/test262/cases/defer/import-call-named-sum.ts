export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const left = 4; export const right = 5;');
  return mod.left + mod.right;
}
