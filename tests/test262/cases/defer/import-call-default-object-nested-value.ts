export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default { box: { value: 30 } };');
  return mod.default.box.value;
}
