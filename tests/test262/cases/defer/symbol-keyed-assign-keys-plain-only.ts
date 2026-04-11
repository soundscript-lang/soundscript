export function main(): string {
  const key = Symbol('token');
  const record = Object.assign({ plain: 'x' }, { [key]: 'y' });
  return Object.keys(record).join(';');
}
