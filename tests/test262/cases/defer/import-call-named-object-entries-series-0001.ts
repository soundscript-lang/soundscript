export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 1, second: 2, third: 3 };');
  return Object.entries(mod.value).length;
}
