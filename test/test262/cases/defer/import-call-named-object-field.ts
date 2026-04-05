export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const box = { value: 18 };');
  return mod.box.value;
}
