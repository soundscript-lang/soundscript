export function getAppContainer() {
  const appElement = document.getElementById('app');
  if (!(appElement instanceof Element)) {
    throw new Error('Expected #app to exist.');
  }
  return appElement;
}
