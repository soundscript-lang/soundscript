export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 9, second: 10, third: 11 };');
  return Object.entries(mod.value).length;
}
