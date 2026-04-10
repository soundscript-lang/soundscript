export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 37, second: 38, third: 39 };'
  );
  return Object.entries(mod.value).length;
}
