export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export default Promise.resolve(24);');
  return await mod.default;
}
