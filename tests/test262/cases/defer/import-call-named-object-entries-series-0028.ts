export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 28, second: 29, third: 30 };'
  );
  return Object.entries(mod.value).length;
}
