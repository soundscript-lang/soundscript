export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value=11;');
  return mod.value;
}
