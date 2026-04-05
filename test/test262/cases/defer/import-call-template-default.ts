export async function main(value: number): Promise<number> {
  const mod = await import(`data:text/javascript,export default ${value};`);
  return mod.default;
}
