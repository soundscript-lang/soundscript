export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 13, second: 14, third: 15 };');
  return Object.entries(mod.value).length;
}
