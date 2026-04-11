export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 36, second: 37, third: 38 };');
  return Object.entries(mod.value).length;
}
