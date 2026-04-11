export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 15, second: 16, third: 17 };');
  return Object.entries(mod.value).length;
}
