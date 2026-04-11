export function main(message: string): Promise<number> {
  return Promise.reject(new Error(message)).then(() => 0, () => 1);
}
