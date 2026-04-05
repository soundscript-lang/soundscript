export function main(): boolean {
  const originalPromise = Promise;
  const p = import('data:text/javascript,export const value=4;');
  return p.constructor === originalPromise &&
    Object.getPrototypeOf(p) === originalPromise.prototype &&
    p.then === originalPromise.prototype.then &&
    p.catch === originalPromise.prototype.catch &&
    p.finally === originalPromise.prototype.finally &&
    Object.prototype.hasOwnProperty.call(p, 'then') === false &&
    Object.prototype.hasOwnProperty.call(p, 'catch') === false &&
    Object.prototype.hasOwnProperty.call(p, 'finally') === false;
}
