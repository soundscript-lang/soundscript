export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 38, second: 39, third: 40 };'
  );
  return Object.entries(mod.value).length;
}
