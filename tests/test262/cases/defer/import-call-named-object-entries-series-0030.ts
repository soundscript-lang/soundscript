export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value = { first: 30, second: 31, third: 32 };');
  return Object.entries(mod.value).length;
}
