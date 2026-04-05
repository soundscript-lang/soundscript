export async function main(): Promise<number> {
  return await (await import('data:text/javascript,export default 16;')).default;
}
