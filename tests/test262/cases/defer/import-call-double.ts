export async function main(): Promise<number> {
  const first = await import('data:text/javascript,export const value=2;');
  const second = await import('data:text/javascript,export const value=3;');
  return first.value + second.value;
}
