export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export const box = { left: 1, right: 2 };');
  return Object.keys(mod.box).join(';');
}
