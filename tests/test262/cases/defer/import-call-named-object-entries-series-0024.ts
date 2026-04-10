export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 24, second: 25, third: 26 };'
  );
  return Object.entries(mod.value).length;
}
