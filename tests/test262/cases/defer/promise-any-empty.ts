export function main(): Promise<number> {
  return Promise.any([]).catch(() => 1);
}
