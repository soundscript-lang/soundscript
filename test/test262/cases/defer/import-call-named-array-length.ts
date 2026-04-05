export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const values = [1,2,3,4];');
  return mod.values.length;
}
