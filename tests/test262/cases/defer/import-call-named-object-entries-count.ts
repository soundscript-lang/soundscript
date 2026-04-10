export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const value = { left: 1, right: 2, extra: 3 };'
  );
  return Object.entries(mod.value).length;
}
