export function queueComponentUpdate(callback: () => void): void {
  queueMicrotask(callback);
}

let activeComponentContext: object | null = null;

export function currentComponentContext(): object | null {
  return activeComponentContext;
}

export function withComponentContext<T>(
  context: object | null,
  callback: () => T,
): T {
  const previous = activeComponentContext;
  activeComponentContext = context;
  try {
    return callback();
  } finally {
    activeComponentContext = previous;
  }
}

export function extendComponentContext(
  parent: object | null,
  contextKey: { readonly __sts_component_context_key: symbol },
  value: unknown,
): object {
  const next = Object.create(parent ?? null) as Record<PropertyKey, unknown>;
  next[contextKey.__sts_component_context_key] = value;
  return next;
}

export function readComponentContext(
  context: object | null,
  contextKey: { readonly __sts_component_context_key: symbol },
): unknown {
  const symbol = contextKey.__sts_component_context_key;
  if (context === null || !(symbol in context)) {
    throw new Error('Required component context value was not provided.');
  }
  return (context as Record<PropertyKey, unknown>)[symbol];
}

export interface MountedDomAction<Param = unknown> {
  destroy(): void;
  update(value: Param): void;
}

export function mountDomAction<NodeLike, Param>(
  action: (node: NodeLike, value?: Param) => unknown,
  node: NodeLike,
  value?: Param,
): MountedDomAction<Param> {
  const result = arguments.length >= 3 ? action(node, value) : action(node);
  if (typeof result === 'function') {
    return {
      destroy() {
        result();
      },
      update() {},
    };
  }
  if (result && typeof result === 'object') {
    const record = result as { destroy?: () => void; update?: (value: Param) => void };
    return {
      destroy() {
        record.destroy?.();
      },
      update(nextValue: Param) {
        record.update?.(nextValue);
      },
    };
  }
  return {
    destroy() {},
    update() {},
  };
}

type ExternalInputTarget = object;

export function applyExternalInputsToComponent(
  instance: ExternalInputTarget,
  inputs: Record<string, unknown>,
): void {
  const target = instance as Record<string, unknown>;
  for (const [key, value] of Object.entries(inputs)) {
    const setter = target[`__sts_component_set_${key}`];
    if (typeof setter === 'function') {
      setter.call(instance, value);
      continue;
    }
    target[key] = value;
  }
}

export function componentAttributesFromExternalInputs(
  inputs: Record<string, unknown>,
  propNames: readonly string[],
): Record<string, unknown> {
  const excluded = new Set(propNames);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (excluded.has(key)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

type DomAttributeTarget = {
  addEventListener?(type: string, listener: unknown): void;
  removeEventListener?(type: string, listener: unknown): void;
  removeAttribute?(name: string): void;
  setAttribute?(name: string, value: string): void;
  style?: { cssText: string };
  [key: string]: unknown;
};

function isEventAttributeName(name: string): boolean {
  return /^on[A-Z]/u.test(name);
}

function eventTypeFromAttributeName(name: string): string {
  return name.slice(2).toLowerCase();
}

function applySingleDomAttribute(
  node: DomAttributeTarget,
  name: string,
  value: unknown,
): void {
  if (isEventAttributeName(name)) {
    if (typeof value === 'function') {
      node.addEventListener?.(eventTypeFromAttributeName(name), value);
    }
    return;
  }
  if (name === 'class' || name === 'className') {
    node.className = value == null ? '' : String(value);
    return;
  }
  if (name === 'style') {
    if (node.style) {
      node.style.cssText = value == null ? '' : String(value);
    }
    return;
  }
  if (name === 'value') {
    node.value = value == null ? '' : value;
    return;
  }
  if (name === 'checked' || name === 'disabled') {
    const flag = !!value;
    node[name] = flag;
    if (flag) {
      node.setAttribute?.(name, '');
    } else {
      node.removeAttribute?.(name);
    }
    return;
  }
  if (value === false || value === null || value === undefined) {
    node.removeAttribute?.(name);
    return;
  }
  if (value === true) {
    node.setAttribute?.(name, '');
    return;
  }
  node.setAttribute?.(name, String(value));
}

function clearSingleDomAttribute(
  node: DomAttributeTarget,
  name: string,
  value: unknown,
): void {
  if (isEventAttributeName(name)) {
    if (typeof value === 'function') {
      node.removeEventListener?.(eventTypeFromAttributeName(name), value);
    }
    return;
  }
  if (name === 'class' || name === 'className') {
    node.className = '';
    return;
  }
  if (name === 'style') {
    if (node.style) {
      node.style.cssText = '';
    }
    return;
  }
  if (name === 'value') {
    node.value = '';
    return;
  }
  if (name === 'checked' || name === 'disabled') {
    node[name] = false;
    node.removeAttribute?.(name);
    return;
  }
  node.removeAttribute?.(name);
}

export function applyDomAttributes(
  node: DomAttributeTarget,
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): void {
  if (previous) {
    for (const [name, previousValue] of Object.entries(previous)) {
      if (Object.is(next[name], previousValue)) {
        continue;
      }
      if (!(name in next)) {
        clearSingleDomAttribute(node, name, previousValue);
      } else if (isEventAttributeName(name) && typeof previousValue === 'function') {
        node.removeEventListener?.(eventTypeFromAttributeName(name), previousValue);
      }
    }
  }
  for (const [name, nextValue] of Object.entries(next)) {
    if (previous && Object.is(previous[name], nextValue)) {
      continue;
    }
    applySingleDomAttribute(node, name, nextValue);
  }
}

export type ResourceState = 'pending' | 'resolved' | 'rejected';

export interface Resource<T> {
  readonly __sts_resource: true;
  destroy(): void;
  error: unknown;
  promise: Promise<T>;
  refresh(): boolean;
  state: ResourceState;
  value: T | undefined;
}

function isResource(value: unknown): value is Resource<unknown> {
  return typeof value === 'object' &&
    value !== null &&
    (value as { readonly __sts_resource?: unknown }).__sts_resource === true;
}

export function describeAwaitableInput<T>(
  input: Promise<T> | Resource<T>,
): {
  readonly error: unknown;
  readonly promise: Promise<T>;
  readonly state: ResourceState;
  readonly value: T | undefined;
} {
  if (isResource(input)) {
    return {
      error: input.error,
      promise: input.promise,
      state: input.state,
      value: input.value,
    };
  }
  return {
    error: undefined,
    promise: Promise.resolve(input),
    state: 'pending',
    value: undefined,
  };
}

export function createComponentResource<T, Dependencies>(
  getDependencies: () => Dependencies,
  loader: (deps: Dependencies, signal: AbortSignal) => Promise<T> | T,
  notify: () => void,
): Resource<T> {
  let activeController: AbortController | null = null;
  let activeToken = 0;
  let destroyed = false;
  let hasDependencies = false;
  let previousDependencies: Dependencies | undefined;

  const resource: Resource<T> = {
    __sts_resource: true,
    destroy() {
      destroyed = true;
      activeToken += 1;
      activeController?.abort();
      activeController = null;
    },
    error: undefined,
    promise: Promise.resolve(undefined as T),
    refresh() {
      if (destroyed) {
        return false;
      }
      const nextDependencies = getDependencies();
      if (hasDependencies && Object.is(previousDependencies, nextDependencies)) {
        return false;
      }
      hasDependencies = true;
      previousDependencies = nextDependencies;
      activeToken += 1;
      const token = activeToken;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      resource.state = 'pending';
      resource.value = undefined;
      resource.error = undefined;
      resource.promise = Promise.resolve(loader(nextDependencies, controller.signal));
      notify();
      void resource.promise.then(
        (resolved) => {
          if (destroyed || controller.signal.aborted || token !== activeToken) {
            return;
          }
          resource.state = 'resolved';
          resource.value = resolved;
          resource.error = undefined;
          notify();
        },
        (rejected) => {
          if (destroyed || controller.signal.aborted || token !== activeToken) {
            return;
          }
          resource.state = 'rejected';
          resource.value = undefined;
          resource.error = rejected;
          notify();
        },
      );
      return true;
    },
    state: 'pending',
    value: undefined,
  };

  const initialDependencies = getDependencies();
  hasDependencies = true;
  previousDependencies = initialDependencies;
  const initialController = new AbortController();
  activeController = initialController;
  activeToken = 1;
  resource.promise = Promise.resolve(loader(initialDependencies, initialController.signal));
  void resource.promise.then(
    (resolved) => {
      if (destroyed || initialController.signal.aborted || activeToken !== 1) {
        return;
      }
      resource.state = 'resolved';
      resource.value = resolved;
      resource.error = undefined;
      notify();
    },
    (rejected) => {
      if (destroyed || initialController.signal.aborted || activeToken !== 1) {
        return;
      }
      resource.state = 'rejected';
      resource.value = undefined;
      resource.error = rejected;
      notify();
    },
  );

  return resource;
}
