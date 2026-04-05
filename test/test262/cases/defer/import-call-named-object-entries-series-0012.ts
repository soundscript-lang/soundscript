export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 12, second: 13, third: 14 };');
  return Object.entries(mod.value).length;
}
