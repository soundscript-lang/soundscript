export async function main(): Promise<boolean> {
  const url = 'data:text/javascript,export const value=6;';
  const first = await import(url);
  const second = await import(url);
  return first === second;
}
