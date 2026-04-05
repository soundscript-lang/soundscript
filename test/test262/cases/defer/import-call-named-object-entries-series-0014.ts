export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 14, second: 15, third: 16 };');
  return Object.entries(mod.value).length;
}
