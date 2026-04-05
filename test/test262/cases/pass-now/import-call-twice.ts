export async function main(): Promise<boolean> {
  const [left, right] = await Promise.all([
    import('data:text/javascript,export const value=5;'),
    import('data:text/javascript,export const value=6;'),
  ]);
  return left === right;
}
