export async function main(value: number): Promise<number> {
  const mod = await import(`data:text/javascript,export const value=${value};`);
  return mod.value;
}
