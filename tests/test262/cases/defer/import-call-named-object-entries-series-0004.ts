export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 4, second: 5, third: 6 };');
  return Object.entries(mod.value).length;
}
