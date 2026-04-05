export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 26, second: 27, third: 28 };');
  return Object.entries(mod.value).length;
}
