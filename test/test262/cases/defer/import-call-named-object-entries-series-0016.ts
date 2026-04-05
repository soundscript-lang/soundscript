export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 16, second: 17, third: 18 };');
  return Object.entries(mod.value).length;
}
