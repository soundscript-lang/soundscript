export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 3, second: 4, third: 5 };');
  return Object.entries(mod.value).length;
}
