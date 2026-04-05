export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 31, second: 32, third: 33 };');
  return Object.entries(mod.value).length;
}
