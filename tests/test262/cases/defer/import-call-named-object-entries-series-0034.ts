export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 34, second: 35, third: 36 };');
  return Object.entries(mod.value).length;
}
