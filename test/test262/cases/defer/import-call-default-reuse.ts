export async function main(): Promise<number> {
  const url = 'data:text/javascript,export default 20;';
  const first = await import(url);
  const second = await import(url);
  return first.default + second.default;
}
