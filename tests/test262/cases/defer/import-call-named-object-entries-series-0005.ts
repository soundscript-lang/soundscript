export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 5, second: 6, third: 7 };');
  return Object.entries(mod.value).length;
}
