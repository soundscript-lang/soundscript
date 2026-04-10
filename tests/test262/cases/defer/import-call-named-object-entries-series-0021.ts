export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 21, second: 22, third: 23 };'
  );
  return Object.entries(mod.value).length;
}
