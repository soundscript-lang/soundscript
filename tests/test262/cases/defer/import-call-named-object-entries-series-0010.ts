export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 10, second: 11, third: 12 };'
  );
  return Object.entries(mod.value).length;
}
