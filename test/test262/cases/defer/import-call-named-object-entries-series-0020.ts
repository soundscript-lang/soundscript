export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 20, second: 21, third: 22 };');
  return Object.entries(mod.value).length;
}
