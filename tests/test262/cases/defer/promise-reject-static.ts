export function main(): string {
  void Promise.reject(new Error('boom')).catch(() => undefined);
  return 'rejected';
}
