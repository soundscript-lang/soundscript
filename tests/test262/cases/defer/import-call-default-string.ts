export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export default "ok";');
  return mod.default;
}
