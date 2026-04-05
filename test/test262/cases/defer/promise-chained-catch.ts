export function main(): Promise<number> {
  return Promise.reject(7).catch(() => 1).catch(() => 2);
}
