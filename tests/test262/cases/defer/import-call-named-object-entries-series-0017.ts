export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { first: 17, second: 18, third: 19 };'
  );
  return Object.entries(mod.value).length;
}
