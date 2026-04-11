export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default { value: 17 };');
  return mod.default.value;
}
