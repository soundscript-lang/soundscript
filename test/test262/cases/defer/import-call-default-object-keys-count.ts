export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default { left: 1, right: 2, third: 3 };');
  return Object.keys(mod.default).length;
}
