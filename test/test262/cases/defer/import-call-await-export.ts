export async function main(): Promise<number> {
  const mod = await import('data:text/javascript,export const value=Promise.resolve(8);');
  return await mod.value;
}
