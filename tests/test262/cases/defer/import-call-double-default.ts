export async function main(): Promise<number> {
  const first = await import('data:text/javascript,export default 6;');
  const second = await import('data:text/javascript,export default 7;');
  return first.default + second.default;
}
