export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 22, second: 23, third: 24 };'
  );
  return Object.entries(mod.value).length;
}
