export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 33, second: 34, third: 35 };'
  );
  return Object.entries(mod.value).length;
}
