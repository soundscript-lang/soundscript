export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 32, second: 33, third: 34 };'
  );
  return Object.entries(mod.value).length;
}
