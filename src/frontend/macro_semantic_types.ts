import type { SourceSpan } from './macro_types.ts';

export interface MacroType {
  readonly displayText: string;
}

export type MacroRuntimeKind =
  | 'bigint'
  | 'boolean'
  | 'f32'
  | 'f64'
  | 'function'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'i8'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'u8'
  | 'undefined';

export type MacroFiniteCase =
  | {
    readonly elements: readonly MacroFiniteTupleElement[];
    readonly exactLength: number;
    readonly kind: 'array';
  }
  | { readonly kind: 'class'; readonly className: string }
  | { readonly kind: 'literal'; readonly code: string }
  | {
    readonly kind: 'object';
    readonly properties: readonly MacroFiniteObjectProperty[];
  }
  | { readonly kind: 'runtime'; readonly typeName: MacroRuntimeKind };

export interface MacroFiniteObjectProperty {
  readonly finiteCase: MacroFiniteCase | null;
  readonly key: string;
}

export interface MacroFiniteTupleElement {
  readonly finiteCase: MacroFiniteCase | null;
}

export interface MacroFunctionContext {
  readonly fileName: string;
  readonly hasDeclaredReturnType: boolean;
  readonly isAsync: boolean;
  readonly isGenerator: boolean;
  readonly name?: string;
  readonly returnType: MacroType;
  readonly span: SourceSpan;
}

export interface MacroDependencyReference {
  readonly kind: 'binding' | 'this-member';
  readonly name: string;
}

export interface MacroDependencySet {
  readonly dependencies: readonly MacroDependencyReference[];
  readonly unknown: boolean;
}

export interface CanonicalResultInfo {
  readonly errType: MacroType;
  readonly family: 'option' | 'result';
  readonly okType: MacroType;
  readonly resultType: MacroType;
}

export interface CanonicalResultCarrierInfo extends CanonicalResultInfo {
  readonly requiresAwait: boolean;
}

export interface CanonicalFailureInfo {
  readonly failureType: MacroType;
}

export interface MacroTryResultCarrierInfo extends CanonicalResultInfo {
  readonly kind: 'result';
}

export interface MacroTryNullishCarrierInfo {
  readonly carrierType: MacroType;
  readonly kind: 'nullish';
  readonly nullishKinds: readonly ('null' | 'undefined')[];
  readonly valueType: MacroType;
}

export type MacroTryCarrierInfo =
  | MacroTryNullishCarrierInfo
  | MacroTryResultCarrierInfo;
