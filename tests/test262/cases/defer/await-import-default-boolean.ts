export async function main(): Promise<boolean> {
  return (await import('data:text/javascript,export default true;')).default;
}
