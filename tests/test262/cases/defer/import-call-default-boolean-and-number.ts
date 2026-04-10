export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export default { flag: true, value: 4 };');
  return `${mod.default.flag}:${mod.default.value}`;
}
