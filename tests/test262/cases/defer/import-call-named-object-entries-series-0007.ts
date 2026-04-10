export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 7, second: 8, third: 9 };'
  );
  return Object.entries(mod.value).length;
}
