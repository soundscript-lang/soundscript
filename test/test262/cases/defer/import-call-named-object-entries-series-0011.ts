export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 11, second: 12, third: 13 };');
  return Object.entries(mod.value).length;
}
