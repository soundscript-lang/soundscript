export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 19, second: 20, third: 21 };'
  );
  return Object.entries(mod.value).length;
}
