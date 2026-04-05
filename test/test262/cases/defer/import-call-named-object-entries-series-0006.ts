export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 6, second: 7, third: 8 };');
  return Object.entries(mod.value).length;
}
