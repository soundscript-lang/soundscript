export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 25, second: 26, third: 27 };');
  return Object.entries(mod.value).length;
}
