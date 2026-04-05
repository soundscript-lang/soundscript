export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 35, second: 36, third: 37 };');
  return Object.entries(mod.value).length;
}
