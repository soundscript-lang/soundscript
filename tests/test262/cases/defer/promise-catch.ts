export function main(): Promise<number> {
  return Promise.reject(1).catch((_error) => 2);
}
