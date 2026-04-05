export async function main(): Promise<number> {
  return (await import('data:text/javascript,export const value=14;')).value;
}
