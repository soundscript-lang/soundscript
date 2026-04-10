export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 8, second: 9, third: 10 };'
  );
  return Object.entries(mod.value).length;
}
