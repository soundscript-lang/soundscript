export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export default { left: 1, right: 2 };');
  return Object.keys(mod.default).join(';');
}
