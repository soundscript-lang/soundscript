export async function main(): Promise<number> {
  return (await import('data:text/javascript,export default 15;')).default;
}
