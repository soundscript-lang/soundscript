export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 29, second: 30, third: 31 };');
  return Object.entries(mod.value).length;
}
