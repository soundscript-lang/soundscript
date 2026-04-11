export function main(): Promise<number> {
  return Promise.reject(1).catch(() => 2).finally(() => 3);
}
