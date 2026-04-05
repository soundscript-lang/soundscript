export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 39, second: 40, third: 41 };');
  return Object.entries(mod.value).length;
}
