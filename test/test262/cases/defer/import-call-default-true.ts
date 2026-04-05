export async function main(): Promise<boolean> {
  const mod = await import('data:text/javascript,export default true; export const extra = 2;');
  return mod.default && mod.extra === 2;
}
