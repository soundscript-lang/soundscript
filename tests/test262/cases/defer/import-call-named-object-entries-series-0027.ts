export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 27, second: 28, third: 29 };');
  return Object.entries(mod.value).length;
}
