export async function main(): Promise<number> {
  return (await import('data:text/javascript,export default [1,2,3,4];')).default.length;
}
