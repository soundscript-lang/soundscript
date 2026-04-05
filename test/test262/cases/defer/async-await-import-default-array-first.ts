export async function main(): Promise<number> {
  return (await import('data:text/javascript,export default [9,8,7];')).default[0];
}
