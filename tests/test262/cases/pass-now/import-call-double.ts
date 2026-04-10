export async function main(): Promise<boolean> {
  const first = import('data:text/javascript,export const value=2;');
  const second = import('data:text/javascript,export const value=3;');
  return first !== second;
}
