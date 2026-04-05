export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const values = [4,5,6];');
  return mod.values[0];
}
