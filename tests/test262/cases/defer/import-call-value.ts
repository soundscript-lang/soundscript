export async function main(): Promise<string> {
  const mod = await import('data:text/javascript,export const value=7;');
  return `value:${mod.value}`;
}
