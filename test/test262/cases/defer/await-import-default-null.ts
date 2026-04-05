export async function main(): Promise<null> {
  return (await import('data:text/javascript,export default null;')).default;
}
