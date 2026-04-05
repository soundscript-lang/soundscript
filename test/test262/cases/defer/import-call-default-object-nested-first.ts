export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default { box: { left: 7 } };');
  return mod.default.box.left;
}
