export {};

interface AddEventListenerOptions extends EventListenerOptions {
    once?: boolean;
    passive?: boolean;
    signal?: AbortSignal;
}

type _CustomEvent<T = unknown> = typeof globalThis extends { onmessage: unknown } ? {} : CustomEvent<T>;
interface CustomEvent<T = unknown> extends Event {
    readonly detail: T;
}

interface CustomEventInit<T = unknown> extends EventInit {
    detail?: T;
}

type _Event = typeof globalThis extends { onmessage: unknown } ? {} : Event;
interface Event {
    readonly bubbles: boolean;
    cancelBubble: boolean;
    readonly cancelable: boolean;
    readonly composed: boolean;
    readonly currentTarget: EventTarget | null;
    readonly defaultPrevented: boolean;
    readonly eventPhase: 0 | 2;
    readonly isTrusted: boolean;
    returnValue: boolean;
    readonly srcElement: EventTarget | null;
    readonly target: EventTarget | null;
    readonly timeStamp: number;
    readonly type: string;
    composedPath(): [EventTarget?];
    initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
    preventDefault(): void;
    stopImmediatePropagation(): void;
    stopPropagation(): void;
}

interface EventInit {
    bubbles?: boolean;
    cancelable?: boolean;
    composed?: boolean;
}

interface EventListener {
    (evt: Event): void;
}

interface EventListenerObject {
    handleEvent(object: Event): void;
}

type _EventListenerOptions = typeof globalThis extends { onmessage: unknown } ? {} : EventListenerOptions;
interface EventListenerOptions {
    capture?: boolean;
}

type _EventTarget = typeof globalThis extends { onmessage: unknown } ? {} : EventTarget;
interface EventTarget {
    addEventListener(
        type: string,
        listener: EventListener | EventListenerObject,
        options?: AddEventListenerOptions | boolean,
    ): void;
    dispatchEvent(event: Event): boolean;
    removeEventListener(
        type: string,
        listener: EventListener | EventListenerObject,
        options?: EventListenerOptions | boolean,
    ): void;
}

declare global {
    interface CustomEvent<T = unknown> extends _CustomEvent<T> {}
    var CustomEvent: typeof globalThis extends { onmessage: unknown; CustomEvent: infer T } ? T
        : {
            prototype: CustomEvent;
            new<T>(type: string, eventInitDict?: CustomEventInit<T>): CustomEvent<T>;
        };

    interface Event extends _Event {}
    var Event: typeof globalThis extends { onmessage: unknown; Event: infer T } ? T
        : {
            prototype: Event;
            new(type: string, eventInitDict?: EventInit): Event;
        };

    interface EventListenerOptions extends _EventListenerOptions {}

    interface EventTarget extends _EventTarget {}
    var EventTarget: typeof globalThis extends { onmessage: unknown; EventTarget: infer T } ? T
        : {
            prototype: EventTarget;
            new(): EventTarget;
        };
}
