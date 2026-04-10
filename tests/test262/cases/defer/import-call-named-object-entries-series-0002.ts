export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 2, second: 3, third: 4 };'
  );
  return Object.entries(mod.value).length;
}
