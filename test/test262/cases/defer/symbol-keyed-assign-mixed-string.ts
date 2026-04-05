export function main(): readonly string[] {
  const log: string[] = [];
  const sym1 = Symbol('x');
  const sym2 = Symbol('y');
  const source = {};

  Object.defineProperty(source, sym1, {
    get() {
      log.push('get sym(x)');
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(source, 'a', {
    get() {
      log.push('get a');
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(source, sym2, {
    get() {
      log.push('get sym(y)');
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(source, 'b', {
    get() {
      log.push('get b');
    },
    enumerable: true,
    configurable: true,
  });

  Object.assign({}, source);
  return log;
}
