export async function main(): Promise<number> {
  return (await import('data:text/javascript,export default { value: 26 };')).default.value;
}
