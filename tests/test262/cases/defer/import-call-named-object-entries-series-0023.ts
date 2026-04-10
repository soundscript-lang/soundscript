export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 23, second: 24, third: 25 };'
  );
  return Object.entries(mod.value).length;
}
