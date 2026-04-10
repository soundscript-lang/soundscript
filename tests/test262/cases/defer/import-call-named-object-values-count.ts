export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const box = { left: 1, right: 2 };');
  return Object.values(mod.box).length;
}
