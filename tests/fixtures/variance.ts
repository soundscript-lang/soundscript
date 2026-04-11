import { fixture, type FixtureCase } from '../support/harness.ts';

type NoInferMatrixKind = 'newtype' | 'nominalClass' | 'genericClass';
type NoInferMatrixCarrier = 'direct' | 'array' | 'readonlyArray' | 'tuple' | 'readonlyTuple';
type NoInferMatrixForm = 'local' | 'imported' | 'inline';

const NOINFER_MATRIX_NEWTYPE_LIB_SOURCE = `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`;

const NOINFER_MATRIX_CLASS_LIB_SOURCE = `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`;

const NOINFER_MATRIX_GENERIC_CLASS_LIB_SOURCE = `export interface Animal {
  readonly name: string;
}

export interface Dog extends Animal {
  readonly bark: true;
}

export class Box<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}
`;

function getNoInferMatrixCarrierType(
  innerType: string,
  carrier: NoInferMatrixCarrier,
): string {
  switch (carrier) {
    case 'direct':
      return `NoInfer<${innerType}>`;
    case 'array':
      return `NoInfer<Array<${innerType}>>`;
    case 'readonlyArray':
      return `NoInfer<ReadonlyArray<${innerType}>>`;
    case 'tuple':
      return `NoInfer<[${innerType}]>`;
    case 'readonlyTuple':
      return `NoInfer<readonly [${innerType}]>`;
  }
}

function getNoInferMatrixSetup(
  kind: NoInferMatrixKind,
  form: NoInferMatrixForm,
): {
  extraFiles?: Record<string, string>;
  externName: string;
  formLabel: string;
  kindLabel: string;
  prelude: string;
  sourceAlias: string;
  sourceInnerType: string;
  targetAlias: string;
  targetInnerType: string;
  valueName: string;
} {
  switch (kind) {
    case 'newtype': {
      if (form === 'local') {
        return {
          externName: 'orders',
          formLabel: 'local',
          kindLabel: 'newtype nominality',
          prelude: `// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;
`,
          sourceAlias: 'Orders',
          sourceInnerType: 'OrderId',
          targetAlias: 'Users',
          targetInnerType: 'UserId',
          valueName: 'users',
        };
      }

      if (form === 'imported') {
        return {
          extraFiles: { 'src/lib.sts': NOINFER_MATRIX_NEWTYPE_LIB_SOURCE },
          externName: 'orders',
          formLabel: 'named imported',
          kindLabel: 'newtype nominality',
          prelude: `// #[interop]
import type { OrderId, UserId } from "./lib";
`,
          sourceAlias: 'Orders',
          sourceInnerType: 'OrderId',
          targetAlias: 'Users',
          targetInnerType: 'UserId',
          valueName: 'users',
        };
      }

      return {
        extraFiles: { 'src/lib.sts': NOINFER_MATRIX_NEWTYPE_LIB_SOURCE },
        externName: 'orders',
        formLabel: 'inline import()',
        kindLabel: 'newtype nominality',
        prelude: '',
        sourceAlias: 'Orders',
        sourceInnerType: 'import("./lib").OrderId',
        targetAlias: 'Users',
        targetInnerType: 'import("./lib").UserId',
        valueName: 'users',
      };
    }
    case 'nominalClass': {
      if (form === 'local') {
        return {
          externName: 'orders',
          formLabel: 'local',
          kindLabel: 'nominal class identity',
          prelude: `class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
          sourceAlias: 'Orders',
          sourceInnerType: 'OrderId',
          targetAlias: 'Users',
          targetInnerType: 'UserId',
          valueName: 'users',
        };
      }

      if (form === 'imported') {
        return {
          extraFiles: { 'src/lib.sts': NOINFER_MATRIX_CLASS_LIB_SOURCE },
          externName: 'orders',
          formLabel: 'named imported',
          kindLabel: 'nominal class identity',
          prelude: `// #[interop]
import type { OrderId, UserId } from "./lib";
`,
          sourceAlias: 'Orders',
          sourceInnerType: 'OrderId',
          targetAlias: 'Users',
          targetInnerType: 'UserId',
          valueName: 'users',
        };
      }

      return {
        extraFiles: { 'src/lib.sts': NOINFER_MATRIX_CLASS_LIB_SOURCE },
        externName: 'orders',
        formLabel: 'inline import()',
        kindLabel: 'nominal class identity',
        prelude: '',
        sourceAlias: 'Orders',
        sourceInnerType: 'import("./lib").OrderId',
        targetAlias: 'Users',
        targetInnerType: 'import("./lib").UserId',
        valueName: 'users',
      };
    }
    case 'genericClass': {
      if (form === 'local') {
        return {
          externName: 'dogs',
          formLabel: 'local',
          kindLabel: 'generic-class exact-match',
          prelude: `interface Animal {
  readonly name: string;
}

interface Dog extends Animal {
  readonly bark: true;
}

class Box<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}
`,
          sourceAlias: 'Dogs',
          sourceInnerType: 'Box<Dog>',
          targetAlias: 'Animals',
          targetInnerType: 'Box<Animal>',
          valueName: 'animals',
        };
      }

      if (form === 'imported') {
        return {
          extraFiles: { 'src/lib.sts': NOINFER_MATRIX_GENERIC_CLASS_LIB_SOURCE },
          externName: 'dogs',
          formLabel: 'named imported',
          kindLabel: 'generic-class exact-match',
          prelude: `// #[interop]
import type { Animal, Box, Dog } from "./lib";
`,
          sourceAlias: 'Dogs',
          sourceInnerType: 'Box<Dog>',
          targetAlias: 'Animals',
          targetInnerType: 'Box<Animal>',
          valueName: 'animals',
        };
      }

      return {
        extraFiles: { 'src/lib.sts': NOINFER_MATRIX_GENERIC_CLASS_LIB_SOURCE },
        externName: 'dogs',
        formLabel: 'inline import()',
        kindLabel: 'generic-class exact-match',
        prelude: '',
        sourceAlias: 'Dogs',
        sourceInnerType: 'import("./lib").Box<import("./lib").Dog>',
        targetAlias: 'Animals',
        targetInnerType: 'import("./lib").Box<import("./lib").Animal>',
        valueName: 'animals',
      };
    }
  }
}

function createNoInferCarrierMatrixFixture(
  kind: NoInferMatrixKind,
  carrier: NoInferMatrixCarrier,
  form: NoInferMatrixForm,
): FixtureCase {
  const setup = getNoInferMatrixSetup(kind, form);
  const carrierSlug = carrier === 'readonlyArray'
    ? 'readonly-array'
    : carrier === 'readonlyTuple'
    ? 'readonly-tuple'
    : carrier;
  const kindSlug = kind === 'nominalClass'
    ? 'nominal-class'
    : kind === 'genericClass'
    ? 'generic-class'
    : 'newtype';
  const name = `noinfer-matrix-${kindSlug}-${form}-${carrierSlug}.reject.ts`;
  const carrierLabel = carrier === 'direct'
    ? 'direct wrappers'
    : carrier === 'array'
    ? 'mutable arrays'
    : carrier === 'readonlyArray'
    ? 'readonly arrays'
    : carrier === 'tuple'
    ? 'tuples'
    : 'readonly tuples';
  return fixture(
    name,
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Matrix coverage: NoInfer<T> should preserve ${setup.kindLabel} through
// ${carrierLabel} in ${setup.formLabel} form.
//
${setup.prelude}type ${setup.targetAlias} = ${
      getNoInferMatrixCarrierType(setup.targetInnerType, carrier)
    };
type ${setup.sourceAlias} = ${getNoInferMatrixCarrierType(setup.sourceInnerType, carrier)};

// #[extern]
declare const ${setup.externName}: ${setup.sourceAlias};

const ${setup.valueName}: ${setup.targetAlias} = ${setup.externName};
void ${setup.valueName};
`,
    setup.extraFiles,
  );
}

function createNoInferCarrierMatrixFixtures(): readonly FixtureCase[] {
  const fixtures: FixtureCase[] = [];
  const kinds: readonly NoInferMatrixKind[] = ['newtype', 'nominalClass', 'genericClass'];
  const carriers: readonly NoInferMatrixCarrier[] = [
    'direct',
    'array',
    'readonlyArray',
    'tuple',
    'readonlyTuple',
  ];
  const forms: readonly NoInferMatrixForm[] = ['local', 'imported', 'inline'];

  for (const kind of kinds) {
    for (const carrier of carriers) {
      for (const form of forms) {
        if ((kind === 'nominalClass' || kind === 'genericClass') && carrier === 'direct') {
          continue;
        }
        if (
          kind === 'newtype' &&
          form === 'local' &&
          carrier !== 'direct'
        ) {
          continue;
        }

        fixtures.push(createNoInferCarrierMatrixFixture(kind, carrier, form));
      }
    }
  }

  return fixtures;
}

export const varianceFixtures: readonly FixtureCase[] = [
  fixture(
    'fresh-array-literal-mutable-widen.accept.ts',
    `// @sound-test: accept
//
// Fresh array/tuple literals assigned directly to a wider mutable target
// are sound when they do not smuggle in a narrower mutable alias.

const t: [number, string, boolean] = [1, "hello", true];

const pair: [number, string] = [42, "world"];

const widened: (number | string)[] = [1];
widened.push("Ada");

const names: string[] = [];
names.push("Ada");

function takeTuple(t: [number, boolean | string]): void {}
takeTuple([1, true]);
`,
  ),
  fixture(
    'fresh-object-literal-mutable-widen.accept.ts',
    `// @sound-test: accept
//
// Fresh object literals assigned directly to a wider mutable target
// are sound when the widened fields come from fresh values.
//
const box: { a: number; b: string | number } = { a: 1, b: 2 };
box.b = "two";

let later: { a: number; b: string | number };
later = { a: 3, b: 4 };
later.b = "four";
`,
  ),
  fixture(
    'readonly-covariance.accept.ts',
    `// @sound-test: accept
//
// ReadonlyArray is covariant, which is sound because you cannot mutate through it.

interface Named {
  readonly name: string;
}

interface Person extends Named {
  readonly age: number;
}

function getNames(items: ReadonlyArray<Named>): string[] {
  return items.map((item) => item.name);
}

const people: ReadonlyArray<Person> = [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
];

const names = getNames(people);
`,
  ),
  fixture(
    'readonly-index-signature-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly index signatures support safe covariant assignment.

interface Animal { readonly name: string }
interface Dog extends Animal { readonly breed: string }

const dogIndex: { readonly [key: string]: Dog } = { rex: { name: "Rex", breed: "Shepherd" } };
const animalIndex: { readonly [key: string]: Animal } = dogIndex;
`,
  ),
  fixture(
    'readonly-object-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly object types support safe covariant assignment.

interface Animal {
  readonly name: string;
}

interface Dog extends Animal {
  readonly breed: string;
}

const dog: Dog = { name: "Rex", breed: "Shepherd" };
const animal: Animal = dog;
const animalName: string = animal.name;

interface ReadonlyBox<T> {
  readonly value: T;
}

const dogBox: ReadonlyBox<Dog> = { value: { name: "Rex", breed: "Shepherd" } };
const animalBox: ReadonlyBox<Animal> = dogBox;

function getName(box: ReadonlyBox<Animal>): string {
  return box.value.name;
}

const boxName: string = getName(dogBox);
`,
  ),
  fixture(
    'inferred-producer-covariance.accept.ts',
    `// @sound-test: accept
//
// Unannotated output-only interfaces infer covariance.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface View<T> {
  get(): T;
}

// #[extern]
declare const dogs: View<Dog>;
const animals: View<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'inferred-callback-producer-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Custom thenable callback surfaces are no longer part of the supported async
// model, even when their variance would otherwise be acceptable.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Deferred<T> {
  then<U>(onfulfilled: (value: T) => U): Deferred<U>;
}

// #[extern]
declare const dogs: Deferred<Dog>;
const animals: Deferred<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'inferred-consumer-contravariance.accept.ts',
    `// @sound-test: accept
//
// Unannotated input-only interfaces infer contravariance.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<Animal>;
const dogSink: Sink<Dog> = animalSink;
void dogSink;
`,
  ),
  fixture(
    'inferred-phantom-independent.accept.ts',
    `// @sound-test: accept
//
// Unused type parameters infer independent variance.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Phantom<T> {
  readonly tag: string;
}

// #[extern]
declare const dogs: Phantom<Dog>;
const animals: Phantom<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'inferred-mixed-invariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mixed read/write interfaces infer invariance conservatively.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Cell<T> {
  get(): T;
  set(value: T): void;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-unprovable-alias-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Unsupported alias shapes may not overclaim checked variance in phase 1.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: out)]
type MaybeBox<T> = T extends unknown ? { readonly value: T } : never;

// #[extern]
declare const dogs: MaybeBox<Dog>;
const animals: MaybeBox<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-out-interface.accept.ts',
    `// @sound-test: accept
//
// Checked #[variance(...)] contracts may document a provable producer surface.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: out)]
interface Box<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Box<Dog>;
const animals: Box<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-in-interface.accept.ts',
    `// @sound-test: accept
//
// Checked #[variance(...)] contracts may document a provable consumer surface.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: in)]
interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<Animal>;
const dogSink: Sink<Dog> = animalSink;
void dogSink;
`,
  ),
  fixture(
    'annotated-independent-interface.accept.ts',
    `// @sound-test: accept
//
// Independent parameters may be documented explicitly too.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: independent)]
interface Phantom<T> {
  readonly tag: string;
}

// #[extern]
declare const dogs: Phantom<Dog>;
const animals: Phantom<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-type-alias.accept.ts',
    `// @sound-test: accept
//
// Type aliases may also carry checked variance contracts.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: out)]
type ReadonlyBox<T> = {
  readonly value: T;
};

// #[extern]
declare const dogs: ReadonlyBox<Dog>;
const animals: ReadonlyBox<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-inout-interface.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Explicit inout contracts preserve exact-match assignment.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[variance(T: inout)]
interface Cell<T> {
  get(): T;
  set(value: T): void;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
  ),
  fixture(
    'annotated-variance-mismatch.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Overclaimed checked variance contracts are rejected.

// #[variance(T: out)]
interface Sink<T> {
  put(value: T): void;
}
`,
  ),
  fixture(
    'annotated-variance-missing-parameter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// Variance contracts must mention every type parameter exactly once.

// #[variance(T: out)]
interface Pair<T, U> {
  readonly left: T;
  readonly right: U;
}
`,
  ),
  fixture(
    'annotated-variance-missing-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// #[variance] requires an explicit total contract.

// #[variance]
interface Box<T> {
  readonly value: T;
}
`,
  ),
  fixture(
    'annotated-variance-duplicate-parameter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// Duplicate entries are rejected.

// #[variance(T: out, T: in)]
interface Box<T> {
  readonly value: T;
}
`,
  ),
  fixture(
    'annotated-variance-invalid-entry.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// Only out, in, inout, and independent are valid variance keywords.

// #[variance(T: sideways)]
interface Box<T> {
  readonly value: T;
}
`,
  ),
  fixture(
    'annotated-variance-unknown-parameter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// Unknown parameter names are rejected.

// #[variance(U: out)]
interface Box<T> {
  readonly value: T;
}
`,
  ),
  fixture(
    'annotated-merged-interface-duplicate-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1031 "Variance annotation contract is invalid."
//
// Merged interfaces may only carry one checked variance contract.

// #[variance(T: out)]
interface Box<T> {
  readonly left: T;
}

// #[variance(T: out)]
interface Box<T> {
  readonly right: T;
}
`,
  ),
  fixture(
    'trusted-relation-does-not-waive-variance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// unsafe is not a generic escape hatch for variance or assignment rules.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  bark(): void;
}

// #[extern]
declare const dogs: Dog[];

// #[unsafe]
const animals: Animal[] = dogs;
void animals;
`,
  ),
  fixture(
    'readonly-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A readonly property should not launder mutable array covariance through its
// payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly pets: Dog[] } = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: { readonly pets: Animal[] } = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'readonly-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A readonly property should not launder mutable Map variance through its
// payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly pets: Map<string, Dog> } = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: { readonly pets: Map<string, Animal> } = dogs;
animals.pets.set("milo", { name: "Milo" });
dogs.pets.get("milo")?.breed;
`,
  ),
  fixture(
    'readonly-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A readonly property should not launder mutable Set variance through its
// payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly pets: Set<Dog> } = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: { readonly pets: Set<Animal> } = dogs;
animals.pets.add({ name: "Milo" });

for (const pet of dogs.pets) {
  pet.breed;
}
`,
  ),
  fixture(
    'readonly-tuple-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A readonly property should not launder mutable tuple covariance through its
// payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly pets: [Dog] } = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: { readonly pets: [Animal] } = dogs;
animals.pets[0] = { name: "Milo" };
dogs.pets[0]!.breed;
`,
  ),
  fixture(
    'readonly-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A top-level nullable readonly array payload should still reject once the
// container payload is normalized.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly pets: Dog[] | null } = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: { readonly pets: Animal[] | null } = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-array-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly<T> should preserve the already-safe covariant case for arrays.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: Readonly<Dog[]> = [{ name: "Rex", breed: "Lab" }];
const animals: Readonly<Animal[]> = dogs;
const firstAnimal = animals[0];
if (firstAnimal !== undefined) {
  const animalName = firstAnimal.name;
  void animalName;
}
`,
  ),
  fixture(
    'readonly-map-covariance.accept.ts',
    `// @sound-test: accept
//
// ReadonlyMap is sound for covariant usage.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function getNames(map: ReadonlyMap<string, Animal>): string[] {
  return Array.from(map.values(), (value) => value.name);
}

const dogs = new Map<string, Dog>([["rex", { name: "Rex", breed: "Lab" }]]);
const names = getNames(dogs);
`,
  ),
  fixture(
    'readonly-set-covariance.accept.ts',
    `// @sound-test: accept
//
// ReadonlySet is sound for covariant usage.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function listNames(set: ReadonlySet<Animal>): string[] {
  return Array.from(set, (value) => value.name);
}

const dogs = new Set<Dog>([{ name: "Rex", breed: "Lab" }]);
const names = listNames(dogs);
`,
  ),
  fixture(
    'promise-covariance.accept.ts',
    `// @sound-test: accept
//
// Promise is declaration-driven covariant in its resolved value.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Promise<Dog>;
const animals: Promise<Animal> = dogs;
`,
  ),
  fixture(
    'promise-to-promiselike-covariance.accept.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// PromiseLike wrappers are no longer part of the supported async surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Promise<Dog>;
const animals: PromiseLike<Animal> = dogs;
`,
  ),
  fixture(
    'promiselike-covariance.accept.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// PromiseLike is banned as an authorable async surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: PromiseLike<Dog>;
const animals: PromiseLike<Animal> = dogs;
`,
  ),
  fixture(
    'invariant-same-type.accept.ts',
    `// @sound-test: accept
//
// Mutable arrays with the same element type are fine under invariance.

const a: string[] = ["hello", "world"];
const b: string[] = a;

function processStrings(items: string[]): number {
  return items.length;
}

const count = processStrings(a);
`,
  ),
  fixture(
    'generic-invariance-workaround.accept.ts',
    `// @sound-test: accept
//
// Using generics to avoid the mutable covariance problem.

interface Serializable {
  serialize(): string;
}

class UserId implements Serializable {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  serialize(): string {
    return this.value;
  }
}

function serializeAll<T extends Serializable>(items: T[]): string[] {
  return items.map((item) => item.serialize());
}

const ids = [new UserId("a"), new UserId("b")];
const serialized = serializeAll(ids);
`,
  ),
  fixture(
    'generic-class-exact-match-same-instantiation.accept.ts',
    `// @sound-test: accept
//
// Exact same generic class instantiations should still relate.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }
}

const dogs = new Box<Dog>({ name: "Rex", breed: "Lab" });
const same: Box<Dog> = dogs;
same.value = { name: "Milo", breed: "Beagle" };
dogs.value.breed;
`,
  ),
  fixture(
    'generic-class-noinfer-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase generic-class exact-match requirements.
//
interface Animal {
  readonly name: string;
}

interface Dog extends Animal {
  readonly bark: true;
}

class Box<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}

type Animals = NoInfer<Box<Animal>>;
type Dogs = NoInfer<Box<Dog>>;

// #[extern]
declare const dogs: Dogs;

const animals: Animals = dogs;
void animals;
`,
  ),
  fixture(
    'generic-class-imported-noinfer-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Named imported generic classes should stay exact-match through NoInfer<T>
// too.
//
// #[interop]
import type { Animal, Box, Dog } from "./lib";

type Animals = NoInfer<Box<Animal>>;
type Dogs = NoInfer<Box<Dog>>;

// #[extern]
declare const dogs: Dogs;

const animals: Animals = dogs;
void animals;
`,
    {
      'src/lib.sts': `export interface Animal {
  readonly name: string;
}

export interface Dog extends Animal {
  readonly bark: true;
}

export class Box<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'generic-class-inline-import-noinfer-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Inline import() generic classes should stay exact-match through NoInfer<T>
// too.
//
type Animals = NoInfer<import("./lib").Box<import("./lib").Animal>>;
type Dogs = NoInfer<import("./lib").Box<import("./lib").Dog>>;

// #[extern]
declare const dogs: Dogs;

const animals: Animals = dogs;
void animals;
`,
    {
      'src/lib.sts': `export interface Animal {
  readonly name: string;
}

export interface Dog extends Animal {
  readonly bark: true;
}

export class Box<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'noinfer-tuple-variance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not launder mutable tuple variance.
//
interface Animal {
  readonly name: string;
}

interface Dog extends Animal {
  readonly bark: true;
}

type Animals = NoInfer<[Animal]>;
type Dogs = NoInfer<[Dog]>;

// #[extern]
declare const dogs: Dogs;

const animals: Animals = dogs;
void animals;
`,
  ),
  fixture(
    'noinfer-newtype-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through mutable arrays.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<UserId[]>;
type Orders = NoInfer<OrderId[]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  fixture(
    'noinfer-newtype-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through tuples.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<[UserId]>;
type Orders = NoInfer<[OrderId]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  fixture(
    'noinfer-newtype-readonly-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through readonly tuples.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<readonly [UserId]>;
type Orders = NoInfer<readonly [OrderId]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  fixture(
    'noinfer-newtype-readonly-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through readonly arrays.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<readonly UserId[]>;
type Orders = NoInfer<readonly OrderId[]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  fixture(
    'noinfer-newtype-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through optional tuple
// elements.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<[UserId?]>;
type Orders = NoInfer<[OrderId?]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  fixture(
    'noinfer-newtype-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// NoInfer<T> should not erase newtype nominality through rest tuple
// elements.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Users = NoInfer<[number, ...UserId[]]>;
type Orders = NoInfer<[number, ...OrderId[]]>;

// #[extern]
declare const orders: Orders;

const users: Users = orders;
void users;
`,
  ),
  ...createNoInferCarrierMatrixFixtures(),
  fixture(
    'nominal-class-same-instance.accept.ts',
    `// @sound-test: accept
//
// Class instance types remain assignable to the exact same class type.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

const user = new UserId("a");
const same: UserId = user;
same.value;
`,
  ),
  fixture(
    'nominal-class-unrelated-structural.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Unrelated classes should not remain structurally interchangeable.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

const order = new OrderId("o1");
const user: UserId = order;
void user;
`,
  ),
  fixture(
    'nominal-class-object-literal.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Object literals should not masquerade as class instances.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

const user: UserId = { value: "u1" };
void user;
`,
  ),
  fixture(
    'nominal-class-subclass-to-base.accept.ts',
    `// @sound-test: accept
//
// Declared subclass-to-base relations remain valid under nominal class typing.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class AdminUserId extends UserId {}

const admin = new AdminUserId("a1");
const user: UserId = admin;
user.value;
`,
  ),
  fixture(
    'nominal-class-interface-projection.accept.ts',
    `// @sound-test: accept
//
// Classes may still satisfy structural interfaces explicitly.
//
interface UserView {
  readonly value: string;
}

class UserId implements UserView {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

const user: UserView = new UserId("u1");
user.value;
`,
  ),
  fixture(
    'nominal-class-readonly-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Readonly wrappers should not launder unrelated class instance types.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

const orders: readonly OrderId[] = [new OrderId("o1")];
const users: readonly UserId[] = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Tuples should not launder unrelated class instance types.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

// #[extern]
declare const orders: [OrderId];

const users: [UserId] = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Optional tuple elements should preserve class nominality too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

// #[extern]
declare const orders: [OrderId?];

const users: [UserId?] = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-prefixed-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Prefixed rest tuples should preserve class nominality too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

// #[extern]
declare const orders: [prefix: number, ...OrderId[]];

const users: [prefix: number, ...UserId[]] = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-tuple-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Class tuple carriers should stay nominal at call sites too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

// #[extern]
declare const orders: [OrderId];

function useUsers(value: [UserId]): void {
  void value;
}

useUsers(orders);
`,
  ),
  fixture(
    'nominal-class-tuple-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Class tuple carriers should stay nominal at return sites too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

// #[extern]
declare const makeOrders: () => [OrderId];

const makeUsers: () => [UserId] = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'nominal-class-imported-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through tuples too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const orders: [OrderId];

const users: [UserId] = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through tuples too.
//
// #[extern]
declare const orders: [import("./lib").OrderId];

const users: [import("./lib").UserId] = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-extract-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Extract<T, U> should not erase nominal class identity.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type User = Extract<UserId | number, UserId | number>;
type Order = Extract<OrderId | number, OrderId | number>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
  ),
  fixture(
    'nominal-class-imported-extract-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through Extract<T, U> too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type User = Extract<UserId | number, UserId | number>;
type Order = Extract<OrderId | number, OrderId | number>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-extract-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through Extract<T, U> too.
//
type User = Extract<import("./lib").UserId | number, import("./lib").UserId | number>;
type Order = Extract<import("./lib").OrderId | number, import("./lib").OrderId | number>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-noinfer-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// NoInfer<T> should not erase nominal class identity.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type User = NoInfer<UserId>;
type Order = NoInfer<OrderId>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
  ),
  fixture(
    'nominal-class-imported-noinfer-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through NoInfer<T> too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type User = NoInfer<UserId>;
type Order = NoInfer<OrderId>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-noinfer-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through NoInfer<T> too.
//
type User = NoInfer<import("./lib").UserId>;
type Order = NoInfer<import("./lib").OrderId>;

// #[extern]
declare const order: Order;

const user: User = order;
void user;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// OmitThisParameter<T> should preserve nominal class identity too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

// #[extern]
declare const takeOrders: OmitThisParameter<OrderFn>;

const takeUsers: OmitThisParameter<UserFn> = takeOrders;
void takeUsers;
`,
  ),
  fixture(
    'nominal-class-imported-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// too.
//
// #[interop]
import { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

// #[extern]
declare const takeOrders: OmitThisParameter<OrderFn>;

const takeUsers: OmitThisParameter<UserFn> = takeOrders;
void takeUsers;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

// #[extern]
declare const takeOrders: OmitThisParameter<OrderFn>;

const takeUsers: OmitThisParameter<UserFn> = takeOrders;
void takeUsers;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-omit-this-readonly-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1035 "Receiver-sensitive callables are not first-class values in soundscript."
//
// OmitThisParameter<T> should preserve nominal class identity through
// readonly-array carriers too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: readonly OmitThisParameter<OrderFn>[];

const user: readonly OmitThisParameter<UserFn>[] = order;
void user;
`,
  ),
  fixture(
    'nominal-class-omit-this-readonly-array-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1035 "Receiver-sensitive callables are not first-class values in soundscript."
//
// Readonly-array OmitThisParameter<T> carriers should also reject at call
// sites.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: readonly OmitThisParameter<OrderFn>[];

function takesUser(values: readonly OmitThisParameter<UserFn>[]) {
  void values;
}

takesUser(order);
`,
  ),
  fixture(
    'nominal-class-omit-this-union.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1035 "Receiver-sensitive callables are not first-class values in soundscript."
//
// OmitThisParameter<T> should preserve nominal class identity through unions
// too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: OmitThisParameter<OrderFn> | null;

const user: OmitThisParameter<UserFn> | null = order;
void user;
`,
  ),
  fixture(
    'nominal-class-omit-this-union-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1035 "Receiver-sensitive callables are not first-class values in soundscript."
//
// Union-wrapped OmitThisParameter<T> carriers should also reject at call
// sites.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: OmitThisParameter<OrderFn> | null;

function takesUser(value: OmitThisParameter<UserFn> | null) {
  void value;
}

takesUser(order);
`,
  ),
  fixture(
    'nominal-class-omit-this-overload.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1035 "Receiver-sensitive callables are not first-class values in soundscript."
//
// Overload sets should not let a plain branch mask an unsound
// OmitThisParameter<T> branch.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

interface UserBox {
  (value: OmitThisParameter<UserFn>): void;
  (value: string): void;
}

interface OrderBox {
  (value: OmitThisParameter<OrderFn>): void;
  (value: string): void;
}

// #[extern]
declare const order: OrderBox;

const user: UserBox = order;
void user;
`,
  ),
  fixture(
    'nominal-class-omit-this-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// OmitThisParameter<T> should preserve nominal class typing at return sites
// too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

// #[extern]
declare const makeOrders: () => OmitThisParameter<OrderFn>;

const makeUsers: () => OmitThisParameter<UserFn> = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'nominal-class-omit-this-property-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// OmitThisParameter<T> should preserve nominal class typing inside property
// payloads too.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserBox {
  readonly handler: OmitThisParameter<UserFn>;
}

interface OrderBox {
  readonly handler: OmitThisParameter<OrderFn>;
}

// #[extern]
declare const orders: OrderBox;

const users: UserBox = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-union-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Local union aliases should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserMaybe = OmitThisParameter<UserFn> | null;
type OrderMaybe = OmitThisParameter<OrderFn> | null;

// #[extern]
declare const orders: OrderMaybe;

const users: UserMaybe = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-tuple-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Local tuple aliases should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserTuple = [OmitThisParameter<UserFn>];
type OrderTuple = [OmitThisParameter<OrderFn>];

// #[extern]
declare const orders: OrderTuple;

const users: UserTuple = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-optional-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Optional parameters should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserSink = (value?: OmitThisParameter<UserFn>) => void;
type OrderSink = (value?: OmitThisParameter<OrderFn>) => void;

// #[extern]
declare const orders: OrderSink;

const users: UserSink = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-constructor-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Construct signatures should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserCtor {
  new (value: OmitThisParameter<UserFn>): object;
}

interface OrderCtor {
  new (value: OmitThisParameter<OrderFn>): object;
}

// #[extern]
declare const orders: OrderCtor;

const users: UserCtor = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-overload-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Overloads should not launder nominal classes through OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserOverload {
  (value: OmitThisParameter<UserFn>): void;
  (value: number): void;
}

interface OrderOverload {
  (value: OmitThisParameter<OrderFn>): void;
  (value: number): void;
}

// #[extern]
declare const orders: OrderOverload;

const users: UserOverload = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-optional-tuple-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Optional tuple elements should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserTuple = [OmitThisParameter<UserFn>?];
type OrderTuple = [OmitThisParameter<OrderFn>?];

// #[extern]
declare const orders: OrderTuple;

const users: UserTuple = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-omit-this-rest-tuple-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Rest tuple elements should not launder nominal classes through
// OmitThisParameter<T>.
//
class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserTuple = [number, ...OmitThisParameter<UserFn>[]];
type OrderTuple = [number, ...OmitThisParameter<OrderFn>[]];

// #[extern]
declare const orders: OrderTuple;

const users: UserTuple = orders;
void users;
`,
  ),
  fixture(
    'nominal-class-imported-omit-this-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// return sites too.
//
// #[interop]
import { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

// #[extern]
declare const makeOrders: () => OmitThisParameter<OrderFn>;

const makeUsers: () => OmitThisParameter<UserFn> = makeOrders;
void makeUsers;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-imported-omit-this-property-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// property payloads too.
//
// #[interop]
import { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserBox {
  readonly handler: OmitThisParameter<UserFn>;
}

interface OrderBox {
  readonly handler: OmitThisParameter<OrderFn>;
}

// #[extern]
declare const orders: OrderBox;

const users: UserBox = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// return sites too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

// #[extern]
declare const makeOrders: () => OmitThisParameter<OrderFn>;

const makeUsers: () => OmitThisParameter<UserFn> = makeOrders;
void makeUsers;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-property-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// property payloads too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

interface UserBox {
  readonly handler: OmitThisParameter<UserFn>;
}

interface OrderBox {
  readonly handler: OmitThisParameter<OrderFn>;
}

// #[extern]
declare const orders: OrderBox;

const users: UserBox = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-imported-omit-this-optional-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// when carried by optional parameters too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

type UserSink = (value?: OmitThisParameter<UserFn>) => void;
type OrderSink = (value?: OmitThisParameter<OrderFn>) => void;

// #[extern]
declare const orders: OrderSink;

const users: UserSink = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-optional-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// when carried by optional parameters too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

type UserSink = (value?: OmitThisParameter<UserFn>) => void;
type OrderSink = (value?: OmitThisParameter<OrderFn>) => void;

// #[extern]
declare const orders: OrderSink;

const users: UserSink = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-imported-omit-this-constructor-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// inside construct signatures too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserCtor {
  new (value: OmitThisParameter<UserFn>): object;
}

interface OrderCtor {
  new (value: OmitThisParameter<OrderFn>): object;
}

// #[extern]
declare const orders: OrderCtor;

const users: UserCtor = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-constructor-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// inside construct signatures too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

interface UserCtor {
  new (value: OmitThisParameter<UserFn>): object;
}

interface OrderCtor {
  new (value: OmitThisParameter<OrderFn>): object;
}

// #[extern]
declare const orders: OrderCtor;

const users: UserCtor = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-imported-omit-this-overload-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Named imported classes should stay nominal through OmitThisParameter<T>
// inside overload sets too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (this: { readonly tag: string }, value: UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: OrderId) => void;

interface UserOverload {
  (value: OmitThisParameter<UserFn>): void;
  (value: number): void;
}

interface OrderOverload {
  (value: OmitThisParameter<OrderFn>): void;
  (value: number): void;
}

// #[extern]
declare const orders: OrderOverload;

const users: UserOverload = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'nominal-class-inline-import-omit-this-overload-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Inline import() classes should stay nominal through OmitThisParameter<T>
// inside overload sets too.
//
type UserFn = (this: { readonly tag: string }, value: import("./lib").UserId) => void;
type OrderFn = (this: { readonly tag: string }, value: import("./lib").OrderId) => void;

interface UserOverload {
  (value: OmitThisParameter<UserFn>): void;
  (value: number): void;
}

interface OrderOverload {
  (value: OmitThisParameter<OrderFn>): void;
  (value: number): void;
}

// #[extern]
declare const orders: OrderOverload;

const users: UserOverload = orders;
void users;
`,
    {
      'src/lib.sts': `export class UserId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export class OrderId {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}
`,
    },
  ),
  fixture(
    'newtype-same-alias.accept.ts',
    `// @sound-test: accept
//
// A #[newtype] alias remains assignable to the exact same alias.
//
// #[newtype]
type UserId = string;

function sameUser(user: UserId): UserId {
  const same: UserId = user;
  return same;
}
`,
  ),
  fixture(
    'newtype-underlying-representation.accept.ts',
    `// @sound-test: accept
//
// The defining module may mint its own #[newtype] alias from the raw
// representation.
//
// #[newtype]
type UserId = string;

const user: UserId = "u1";
void user;
`,
  ),
  fixture(
    'newtype-unrelated-structural.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Unrelated #[newtype] aliases should not remain structurally interchangeable.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

function assignOrder(order: OrderId): void {
  const user: UserId = order;
  void user;
}
`,
  ),
  fixture(
    'newtype-readonly-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Readonly wrappers should not launder unrelated newtype aliases.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

function assignOrders(orders: readonly OrderId[]): void {
  const users: readonly UserId[] = orders;
  void users;
}
`,
  ),
  fixture(
    'newtype-to-underlying-representation.accept.ts',
    `// @sound-test: accept
//
// The defining module may unwrap its own #[newtype] alias back to the raw
// representation.
//
// #[newtype]
type UserId = string;

function unwrap(user: UserId): string {
  const raw: string = user;
  return raw;
}
`,
  ),
  fixture(
    'newtype-property-flow.accept.ts',
    `// @sound-test: accept
//
// Property reads with a declared newtype type should preserve that identity.
//
// #[newtype]
type UserId = string;

interface Box {
  readonly user: UserId;
}

function readUser(box: Box): UserId {
  const same: UserId = box.user;
  return same;
}
`,
  ),
  fixture(
    'newtype-call-return.accept.ts',
    `// @sound-test: accept
//
// Call expressions with a declared newtype return type should preserve that
// identity.
//
// #[newtype]
type UserId = string;

function id(user: UserId): UserId {
  return user;
}

function sameUser(user: UserId): UserId {
  const same: UserId = id(user);
  return same;
}
`,
  ),
  fixture(
    'newtype-alias-preserves-identity.accept.ts',
    `// @sound-test: accept
//
// Plain aliases of a newtype should keep the same defining-module
// construction privilege.
//
// #[newtype]
type UserId = string;

type Alias = UserId;

const alias: Alias = "u1";
void alias;
`,
  ),
  fixture(
    'newtype-cross-module-alias-preserves-identity.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Plain aliases outside the defining module should still preserve the nominal
// boundary.
//
import type { UserId } from "./lib.sts";

type Alias = UserId;

const alias: Alias = "u1";
void alias;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;
`,
    },
  ),
  fixture(
    'newtype-cross-module-construction.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Imported newtypes should not be constructible from their raw representation
// outside the defining module.
//
import type { UserId } from "./lib.sts";

const user: UserId = "u1";
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;
`,
    },
  ),
  fixture(
    'newtype-cross-module-unwrap.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Imported newtypes should not implicitly unwrap outside the defining module.
//
import { user } from "./lib.sts";

const raw: string = user;
void raw;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

export const user: UserId = "u1";
`,
    },
  ),
  fixture(
    'newtype-type-predicate-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Type predicate signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const isOrder: (value: string) => value is OrderId;

const isUser: (value: string) => value is UserId = isOrder;
void isUser;
`,
  ),
  fixture(
    'newtype-assertion-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Assertion signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const assertOrder: (value: string) => asserts value is OrderId;

const assertUser: (value: string) => asserts value is UserId = assertOrder;
void assertUser;
`,
  ),
  fixture(
    'newtype-function-parameter-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Ordinary function parameter signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const takeOrders: (value: OrderId) => void;

const takeUsers: (value: UserId) => void = takeOrders;
void takeUsers;
`,
  ),
  fixture(
    'newtype-function-return-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Ordinary function return signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const makeOrders: () => OrderId;

const makeUsers: () => UserId = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'newtype-method-parameter-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Method parameter signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderConsumer {
  use(value: OrderId): void;
}

interface UserConsumer {
  use(value: UserId): void;
}

// #[extern]
declare const orderConsumer: OrderConsumer;

const userConsumer: UserConsumer = orderConsumer;
void userConsumer;
`,
  ),
  fixture(
    'newtype-constructor-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Constructor signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const OrderBox: new (value: OrderId) => { readonly value: string };

const UserBox: new (value: UserId) => { readonly value: string } = OrderBox;
void UserBox;
`,
  ),
  fixture(
    'newtype-imported-function-parameter-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through ordinary function
// parameter signatures too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const takeOrders: (value: OrderId) => void;

const takeUsers: (value: UserId) => void = takeOrders;
void takeUsers;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-type-predicate-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through type predicate
// signatures too.
//
// #[extern]
declare const isOrder: (value: string) => value is import("./lib").OrderId;

const isUser: (value: string) => value is import("./lib").UserId = isOrder;
void isUser;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-readonly-string-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Readonly string index signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  readonly [key: string]: OrderId;
}

interface UserMap {
  readonly [key: string]: UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-mutable-string-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Mutable string index signatures should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  [key: string]: OrderId;
}

interface UserMap {
  [key: string]: UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-readonly-number-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Numeric readonly index signatures should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  readonly [index: number]: OrderId;
}

interface UserMap {
  readonly [index: number]: UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-mutable-number-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Numeric mutable index signatures should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  [index: number]: OrderId;
}

interface UserMap {
  [index: number]: UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-readonly-index-signature-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Index-signature nominality should hold at ordinary call sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  readonly [key: string]: OrderId;
}

function useUsers(map: { readonly [key: string]: UserId }): void {
  void map;
}

// #[extern]
declare const orders: OrderMap;

useUsers(orders);
`,
  ),
  fixture(
    'newtype-readonly-index-signature-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Index-signature nominality should hold at function return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface OrderMap {
  readonly [key: string]: OrderId;
}

// #[extern]
declare const makeOrders: () => OrderMap;

const makeUsers: () => { readonly [key: string]: UserId } = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'newtype-imported-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through index signatures too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

interface OrderMap {
  readonly [key: string]: OrderId;
}

interface UserMap {
  readonly [key: string]: UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through index signatures too.
//
interface OrderMap {
  readonly [key: string]: import("./lib").OrderId;
}

interface UserMap {
  readonly [key: string]: import("./lib").UserId;
}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-type-alias-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Type-alias index signatures should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type OrderMap = { readonly [key: string]: OrderId };
type UserMap = { readonly [key: string]: UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-mapped-type.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Mapped object types should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type OrderMap = { [K in "id"]: OrderId };
type UserMap = { [K in "id"]: UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-imported-type-alias-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through type-alias index
// signatures too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type OrderMap = { readonly [key: string]: OrderId };
type UserMap = { readonly [key: string]: UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-type-alias-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through type-alias index
// signatures too.
//
type OrderMap = { readonly [key: string]: import("./lib").OrderId };
type UserMap = { readonly [key: string]: import("./lib").UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-conditional-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Identity-style conditional wrappers should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Wrapper<T> = T extends unknown ? T : never;

// #[extern]
declare const order: Wrapper<OrderId>;

const user: Wrapper<UserId> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-conditional-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through identity-style
// conditional wrappers too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type Wrapper<T> = T extends unknown ? T : never;

// #[extern]
declare const order: Wrapper<OrderId>;

const user: Wrapper<UserId> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-conditional-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through identity-style
// conditional wrappers too.
//
type Wrapper<T> = T extends unknown ? T : never;

// #[extern]
declare const order: Wrapper<import("./lib.sts").OrderId>;

const user: Wrapper<import("./lib.sts").UserId> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-conditional-wrapper-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Identity-style conditional wrappers should preserve newtype nominality at
// return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type Wrapper<T> = T extends unknown ? T : never;

// #[extern]
declare const makeOrder: () => Wrapper<OrderId>;

const makeUser: () => Wrapper<UserId> = makeOrder;
void makeUser;
`,
  ),
  fixture(
    'newtype-awaited-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Awaited<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: Awaited<OrderId>;

const user: Awaited<UserId> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-awaited-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through Awaited<T> too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const order: Awaited<OrderId>;

const user: Awaited<UserId> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-awaited-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through Awaited<T> too.
//
// #[extern]
declare const order: Awaited<import("./lib").OrderId>;

const user: Awaited<import("./lib").UserId> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-awaited-wrapper-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Awaited<T> should preserve newtype nominality at return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const makeOrder: () => Awaited<OrderId>;

const makeUser: () => Awaited<UserId> = makeOrder;
void makeUser;
`,
  ),
  fixture(
    'newtype-returntype-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// ReturnType<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type UserFn = () => UserId;
type OrderFn = () => OrderId;

// #[extern]
declare const order: ReturnType<OrderFn>;

const user: ReturnType<UserFn> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-returntype-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through ReturnType<T> too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = () => UserId;
type OrderFn = () => OrderId;

// #[extern]
declare const order: ReturnType<OrderFn>;

const user: ReturnType<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-returntype-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through ReturnType<T> too.
//
type UserFn = () => import("./lib").UserId;
type OrderFn = () => import("./lib").OrderId;

// #[extern]
declare const order: ReturnType<OrderFn>;

const user: ReturnType<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Parameters<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type UserFn = (value: UserId) => void;
type OrderFn = (value: OrderId) => void;

// #[extern]
declare const order: Parameters<OrderFn>;

const user: Parameters<UserFn> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through Parameters<T> too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (value: UserId) => void;
type OrderFn = (value: OrderId) => void;

// #[extern]
declare const order: Parameters<OrderFn>;

const user: Parameters<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through Parameters<T> too.
//
type UserFn = (value: import("./lib").UserId) => void;
type OrderFn = (value: import("./lib").OrderId) => void;

// #[extern]
declare const order: Parameters<OrderFn>;

const user: Parameters<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-constructor-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// ConstructorParameters<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type UserCtor = new (value: UserId) => UserId;
type OrderCtor = new (value: OrderId) => OrderId;

// #[extern]
declare const order: ConstructorParameters<OrderCtor>;

const user: ConstructorParameters<UserCtor> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-constructor-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through ConstructorParameters<T>
// too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserCtor = new (value: UserId) => UserId;
type OrderCtor = new (value: OrderId) => OrderId;

// #[extern]
declare const order: ConstructorParameters<OrderCtor>;

const user: ConstructorParameters<UserCtor> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-constructor-parameters-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through
// ConstructorParameters<T> too.
//
type UserCtor = new (value: import("./lib").UserId) => import("./lib").UserId;
type OrderCtor = new (value: import("./lib").OrderId) => import("./lib").OrderId;

// #[extern]
declare const order: ConstructorParameters<OrderCtor>;

const user: ConstructorParameters<UserCtor> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-this-parameter-type-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// ThisParameterType<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type UserFn = (this: UserId) => void;
type OrderFn = (this: OrderId) => void;

// #[extern]
declare const order: ThisParameterType<OrderFn>;

const user: ThisParameterType<UserFn> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-this-parameter-type-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through ThisParameterType<T>
// too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (this: UserId) => void;
type OrderFn = (this: OrderId) => void;

// #[extern]
declare const order: ThisParameterType<OrderFn>;

const user: ThisParameterType<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-this-parameter-type-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through ThisParameterType<T>
// too.
//
type UserFn = (this: import("./lib").UserId) => void;
type OrderFn = (this: import("./lib").OrderId) => void;

// #[extern]
declare const order: ThisParameterType<OrderFn>;

const user: ThisParameterType<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// OmitThisParameter<T> should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: OmitThisParameter<OrderFn>;

const user: OmitThisParameter<UserFn> = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through OmitThisParameter<T>
// too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type UserFn = (this: UserId, value: number) => void;
type OrderFn = (this: OrderId, value: number) => void;

// #[extern]
declare const order: OmitThisParameter<OrderFn>;

const user: OmitThisParameter<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-omit-this-parameter-wrapper.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through OmitThisParameter<T>
// too.
//
type UserFn = (this: import("./lib").UserId, value: number) => void;
type OrderFn = (this: import("./lib").OrderId, value: number) => void;

// #[extern]
declare const order: OmitThisParameter<OrderFn>;

const user: OmitThisParameter<UserFn> = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-imported-mapped-type.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through mapped object types too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

type OrderMap = { [K in "id"]: OrderId };
type UserMap = { [K in "id"]: UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-mapped-type.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through mapped object types
// too.
//
type OrderMap = { [K in "id"]: import("./lib").OrderId };
type UserMap = { [K in "id"]: import("./lib").UserId };

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-nullable-union.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Nullable unions should still preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: OrderId | null;

const user: UserId | null = order;
void user;
`,
  ),
  fixture(
    'newtype-optional-union.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Optional unions should still preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: OrderId | undefined;

const user: UserId | undefined = order;
void user;
`,
  ),
  fixture(
    'newtype-mixed-union-branch.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Mixed unions with ordinary branches should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: OrderId | number;

const user: UserId | number = order;
void user;
`,
  ),
  fixture(
    'newtype-union-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Union-wrapped newtypes should stay nominal at call sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: OrderId | null;

function useUser(value: UserId | null): void {
  void value;
}

useUser(order);
`,
  ),
  fixture(
    'newtype-union-property.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Object properties carrying union-wrapped newtypes should stay nominal too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const order: { readonly value: OrderId | null };

const user: { readonly value: UserId | null } = order;
void user;
`,
  ),
  fixture(
    'newtype-imported-nullable-union.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through nullable unions too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const order: OrderId | null;

const user: UserId | null = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-nullable-union.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through nullable unions too.
//
// #[extern]
declare const order: import("./lib").OrderId | null;

const user: import("./lib").UserId | null = order;
void user;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Optional tuple elements should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [OrderId?];

const users: [UserId?] = orders;
void users;
`,
  ),
  fixture(
    'newtype-readonly-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Readonly optional tuples should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: readonly [OrderId?];

const users: readonly [UserId?] = orders;
void users;
`,
  ),
  fixture(
    'newtype-optional-second-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Later optional tuple elements should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [prefix: number, value?: OrderId];

const users: [prefix: number, value?: UserId] = orders;
void users;
`,
  ),
  fixture(
    'newtype-optional-tuple-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Optional tuple elements should stay nominal at call sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [OrderId?];

function useUsers(value: [UserId?]): void {
  void value;
}

useUsers(orders);
`,
  ),
  fixture(
    'newtype-optional-tuple-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Optional tuple elements should stay nominal at return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const makeOrders: () => [OrderId?];

const makeUsers: () => [UserId?] = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'newtype-imported-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through optional tuples too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const orders: [OrderId?];

const users: [UserId?] = orders;
void users;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-optional-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through optional tuples too.
//
// #[extern]
declare const orders: [import("./lib").OrderId?];

const users: [import("./lib").UserId?] = orders;
void users;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Rest tuple elements should preserve newtype nominality.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [...OrderId[]];

const users: [...UserId[]] = orders;
void users;
`,
  ),
  fixture(
    'newtype-readonly-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Readonly rest tuples should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: readonly [...OrderId[]];

const users: readonly [...UserId[]] = orders;
void users;
`,
  ),
  fixture(
    'newtype-prefixed-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Prefixed rest tuples should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [prefix: number, ...OrderId[]];

const users: [prefix: number, ...UserId[]] = orders;
void users;
`,
  ),
  fixture(
    'newtype-rest-tuple-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Rest tuples should stay nominal at call sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const orders: [...OrderId[]];

function useUsers(value: [...UserId[]]): void {
  void value;
}

useUsers(orders);
`,
  ),
  fixture(
    'newtype-rest-tuple-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Rest tuples should stay nominal at return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

// #[extern]
declare const makeOrders: () => [...OrderId[]];

const makeUsers: () => [...UserId[]] = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'newtype-imported-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through rest tuples too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const orders: [...OrderId[]];

const users: [...UserId[]] = orders;
void users;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-imported-rest-tuple-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Named imported newtypes should stay nominal through rest-tuple returns too.
//
// #[interop]
import type { OrderId, UserId } from "./lib";

// #[extern]
declare const makeOrders: () => [...OrderId[]];

const makeUsers: () => [...UserId[]] = makeOrders;
void makeUsers;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-rest-tuple.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through rest tuples too.
//
// #[extern]
declare const orders: [...import("./lib").OrderId[]];

const users: [...import("./lib").UserId[]] = orders;
void users;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inline-import-rest-tuple-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inline import() newtypes should stay nominal through rest-tuple returns too.
//
// #[extern]
declare const makeOrders: () => [...import("./lib").OrderId[]];

const makeUsers: () => [...import("./lib").UserId[]] = makeOrders;
void makeUsers;
`,
    {
      'src/lib.sts': `// #[newtype]
export type UserId = string;

// #[newtype]
export type OrderId = string;
`,
    },
  ),
  fixture(
    'newtype-inherited-property-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited readonly properties should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface BoxBase<T> {
  readonly value: T;
}

interface OrderBox extends BoxBase<OrderId> {}
interface UserBox extends BoxBase<UserId> {}

// #[extern]
declare const orderBox: OrderBox;

const userBox: UserBox = orderBox;
void userBox;
`,
  ),
  fixture(
    'newtype-inherited-index-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited index signatures should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface MapBase<T> {
  readonly [key: string]: T;
}

interface OrderMap extends MapBase<OrderId> {}
interface UserMap extends MapBase<UserId> {}

// #[extern]
declare const orderMap: OrderMap;

const userMap: UserMap = orderMap;
void userMap;
`,
  ),
  fixture(
    'newtype-inherited-index-signature-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited index signatures should stay nominal at call sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface MapBase<T> {
  readonly [key: string]: T;
}

interface OrderMap extends MapBase<OrderId> {}

function useUsers(map: MapBase<UserId>): void {
  void map;
}

// #[extern]
declare const orderMap: OrderMap;

useUsers(orderMap);
`,
  ),
  fixture(
    'newtype-inherited-index-signature-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited index signatures should stay nominal at return sites too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface MapBase<T> {
  readonly [key: string]: T;
}

interface OrderMap extends MapBase<OrderId> {}

// #[extern]
declare const makeOrders: () => OrderMap;

const makeUsers: () => MapBase<UserId> = makeOrders;
void makeUsers;
`,
  ),
  fixture(
    'newtype-inherited-call-signature-parameter.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited call-signature parameters should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface FnBase<T> {
  (value: T): void;
}

interface OrderFn extends FnBase<OrderId> {}
interface UserFn extends FnBase<UserId> {}

// #[extern]
declare const orderFn: OrderFn;

const userFn: UserFn = orderFn;
void userFn;
`,
  ),
  fixture(
    'newtype-inherited-call-signature-return.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited call-signature returns should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface FnBase<T> {
  (): T;
}

interface OrderFn extends FnBase<OrderId> {}
interface UserFn extends FnBase<UserId> {}

// #[extern]
declare const orderFn: OrderFn;

const userFn: UserFn = orderFn;
void userFn;
`,
  ),
  fixture(
    'newtype-inherited-constructor-signature.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Inherited constructor signatures should preserve newtype nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

interface CtorBase<T> {
  new (): T;
}

interface OrderCtor extends CtorBase<OrderId> {}
interface UserCtor extends CtorBase<UserId> {}

// #[extern]
declare const orderCtor: OrderCtor;

const userCtor: UserCtor = orderCtor;
void userCtor;
`,
  ),
  fixture(
    'newtype-interface-extends-callable-type-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Interfaces extending callable type aliases should preserve newtype
// nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type FnBase<T> = { (value: T): void };

interface OrderFn extends FnBase<OrderId> {}
interface UserFn extends FnBase<UserId> {}

// #[extern]
declare const orderFn: OrderFn;

const userFn: UserFn = orderFn;
void userFn;
`,
  ),
  fixture(
    'newtype-interface-extends-constructor-type-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Newtype aliases are nominal in soundscript."
//
// Interfaces extending constructor type aliases should preserve newtype
// nominality too.
//
// #[newtype]
type UserId = string;

// #[newtype]
type OrderId = string;

type CtorBase<T> = { new (): T };

interface OrderCtor extends CtorBase<OrderId> {}
interface UserCtor extends CtorBase<UserId> {}

// #[extern]
declare const orderCtor: OrderCtor;

const userCtor: UserCtor = orderCtor;
void userCtor;
`,
  ),
  fixture(
    'generic-class-structural-same-argument.accept.ts',
    `// @sound-test: accept
//
// Structurally identical type arguments should still count as the same
// generic class instantiation.
//
class Box<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }
}

const left = new Box<{ name: string }>({ name: "Rex" });
const right: Box<{ name: string }> = left;
right.value.name;
`,
  ),
  fixture(
    'readonly-optional-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly optional properties are safe to treat covariantly.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { readonly value?: Dog } = {
  value: { name: "Rex", breed: "Lab" },
};

const animals: { readonly value?: Animal } = dogs;
const maybeAnimal = animals.value;
`,
  ),
  fixture(
    'argument-site-fresh-array-literal-widen.accept.ts',
    `// @sound-test: accept
//
// Fresh array literals may widen at parameter sites when they do not smuggle
// an existing mutable alias.
//
function takeValues(xs: (number | string)[]): void {
  xs.push("Ada");
}

takeValues([1]);
`,
  ),
  fixture(
    'spread-argument-fresh-array-literal-widen.accept.ts',
    `// @sound-test: accept
//
// Fresh spread arguments may widen when they do not launder an existing
// mutable alias through the relation.
//
function takeValues(xs: (number | string)[]): void {
  xs.push("Ada");
}

takeValues(...([[1]] satisfies [[number]]));
`,
  ),
  fixture(
    'mutable-tuple-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable tuples are invariant in soundscript."
// @sound-note: '[Dog]' cannot be widened to '[Animal]' because writes through the target could store incompatible tuple elements.
// @sound-hint: Use a readonly tuple, copy into a new tuple, or keep the exact tuple type.
//
// Mutable tuples are invariant in soundscript.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: [Dog] = [{ name: "Rex", breed: "Lab" }];
const animals: [Animal] = dogs;
animals[0] = { name: "Milo" };
dogs[0]!.breed;
`,
  ),
  fixture(
    'optional-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Writable property 'value' is invariant in soundscript."
// @sound-note: The target can write 'Animal' to 'value', but the source only accepts 'Dog'.
// @sound-hint: Make the property readonly, copy into a fresh object, or keep the exact property type.
//
// Optional mutable properties remain mutable and should not be treated
// covariantly in soundscript.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { value?: Dog } = {
  value: { name: "Rex", breed: "Lab" },
};

const animals: { value?: Animal } = dogs;
`,
  ),
  fixture(
    'mapped-readonly-preserving-object-covariance.accept.ts',
    `// @sound-test: accept
//
// A readonly-preserving mapped type should keep an already-readonly property
// relation accepted.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type ReadonlyShape<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = ReadonlyShape<{ readonly pet: Animal }>;
type DogPetBox = ReadonlyShape<{ readonly pet: Dog }>;

const dogs: DogPetBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalPetBox = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'mapped-readonly-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A mapped readonly property should still reject when its payload stays a
// mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type ReadonlyShape<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = ReadonlyShape<{ pets: Animal[] }>;
type DogPetBox = ReadonlyShape<{ pets: Dog[] }>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'mapped-readonly-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// A mapped readonly property should still reject when its payload stays a
// mutable Map.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type ReadonlyShape<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = ReadonlyShape<{ pets: Map<string, Animal> }>;
type DogPetBox = ReadonlyShape<{ pets: Map<string, Dog> }>;

const dogs: DogPetBox = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: AnimalPetBox = dogs;
animals.pets.set("milo", { name: "Milo" });
dogs.pets.get("milo")?.breed;
`,
  ),
  fixture(
    'mapped-readonly-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// A mapped readonly property should still reject when its payload stays a
// mutable Set.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type ReadonlyShape<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = ReadonlyShape<{ pets: Set<Animal> }>;
type DogPetBox = ReadonlyShape<{ pets: Set<Dog> }>;

const dogs: DogPetBox = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: AnimalPetBox = dogs;
animals.pets.add({ name: "Milo" });

for (const pet of dogs.pets) {
  pet.breed;
}
`,
  ),
  fixture(
    'mapped-readonly-added-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// In the focused Track 3b checks, this mapped readonly property shape was
// observed to pass for a non-container object payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type ReadonlyShape<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = ReadonlyShape<{ pet: Animal }>;
type DogPetBox = ReadonlyShape<{ pet: Dog }>;

const dogs: DogPetBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalPetBox = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'mapped-minus-readonly-object-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A mapped -readonly transform should not make a restored writable property
// soundly covariant.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type MutableShape<T> = {
  -readonly [K in keyof T]: T[K];
};

type AnimalPetBox = MutableShape<{ readonly pet: Animal }>;
type DogPetBox = MutableShape<{ readonly pet: Dog }>;

const dogs: DogPetBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalPetBox = dogs;
animals.pet = { name: "Milo" };
dogs.pet.breed;
`,
  ),
  fixture(
    'mapped-minus-readonly-array-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A mapped -readonly transform should still reject when it restores a
// writable array property surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type MutableShape<T> = {
  -readonly [K in keyof T]: T[K];
};

type AnimalPetBox = MutableShape<{ readonly pets: Animal[] }>;
type DogPetBox = MutableShape<{ readonly pets: Dog[] }>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
animals.pets = [{ name: "Milo" }];
dogs.pets[0]!.breed;
`,
  ),
  fixture(
    'utility-readonly-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly<T> was observed to pass alongside the direct mapped readonly
// object-property case for the same non-container object payload shape.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet: T;
}

const dogs: Readonly<Box<Dog>> = { pet: { name: "Rex", breed: "Lab" } };
const animals: Readonly<Box<Animal>> = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'utility-readonly-pick-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Readonly<Pick<...>> should preserve the same safe readonly object-property
// covariance as the direct readonly wrapper cases.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet: T;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pet">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pet">>;

const dogs: DogPetBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalPetBox = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'utility-readonly-omit-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Direct Readonly<Omit<...>> should preserve the same safe readonly
// object-property covariance for a non-container payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet: T;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalPetBox = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'utility-readonly-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<T> should not make a writable array payload soundly covariant.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
}

const dogs: Readonly<Box<Dog>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: Readonly<Box<Animal>> = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'utility-readonly-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// Readonly<T> should not make a writable Map payload soundly covariant.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Map<string, T>;
}

const dogs: Readonly<Box<Dog>> = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: Readonly<Box<Animal>> = dogs;
animals.pets.set("milo", { name: "Milo" });
dogs.pets.get("milo")?.breed;
`,
  ),
  fixture(
    'utility-readonly-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// Readonly<T> should not make a writable Set payload soundly covariant.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Set<T>;
}

const dogs: Readonly<Box<Dog>> = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: Readonly<Box<Animal>> = dogs;
animals.pets.add({ name: "Milo" });

for (const pet of dogs.pets) {
  pet.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should not make a mutable array payload soundly
// covariant through a readonly property surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'utility-readonly-pick-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when a top-level nullable readonly
// property payload remains a mutable array after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[] | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-optional-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when the readonly property is
// optional and nullable before exposing a mutable array after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: T[] | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when a top-level nullable readonly
// property payload remains a mutable Map after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Map<string, T> | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.set("milo", { name: "Milo" });
}
if (dogs.pets) {
  dogs.pets.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when a top-level nullable readonly
// property payload remains a mutable Set after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Set<T> | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.add({ name: "Milo" });
}
if (dogs.pets) {
  for (const pet of dogs.pets) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'utility-readonly-pick-optional-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when the readonly property is
// optional and nullable before exposing a mutable Map after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: Map<string, T> | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.set("milo", { name: "Milo" });
}
if (dogs.pets) {
  dogs.pets.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-optional-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// Readonly<Pick<...>> should still reject when the readonly property is
// optional and nullable before exposing a mutable Set after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: Set<T> | null;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.add({ name: "Milo" });
}
if (dogs.pets) {
  for (const pet of dogs.pets) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'utility-readonly-omit-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// payload remains a mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'utility-readonly-omit-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the top-level readonly
// property payload remains a nullable mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[] | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-optional-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is optional and nullable before exposing a mutable array after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: T[] | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the top-level readonly
// property payload remains a nullable mutable Map.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Map<string, T> | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.set("milo", { name: "Milo" });
}
if (dogs.pets) {
  dogs.pets.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the top-level readonly
// property payload remains a nullable mutable Set.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: Set<T> | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.add({ name: "Milo" });
}
if (dogs.pets) {
  for (const pet of dogs.pets) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'utility-readonly-omit-optional-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is optional and nullable before exposing a mutable Map after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: Map<string, T> | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.set("milo", { name: "Milo" });
}
if (dogs.pets) {
  dogs.pets.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-optional-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is optional and nullable before exposing a mutable Set after narrowing.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: Set<T> | null;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: new Set([{ name: "Rex", breed: "Lab" }]),
};

const animals: AnimalPetBox = dogs;
if (animals.pets) {
  animals.pets.add({ name: "Milo" });
}
if (dogs.pets) {
  for (const pet of dogs.pets) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'utility-readonly-pick-nested-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should still reject when the selected readonly property
// is an object whose nested field narrows to a nullable mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: T[] | null;
}

interface Box<T> {
  pets: PetBox<T>;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: {
    list: [{ name: "Rex", breed: "Lab" }],
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.push({ name: "Milo" });
}
if (dogs.pets.list) {
  dogs.pets.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-nested-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is an object whose nested field narrows to a nullable mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: T[] | null;
}

interface Box<T> {
  pets: PetBox<T>;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: {
    list: [{ name: "Rex", breed: "Lab" }],
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.push({ name: "Milo" });
}
if (dogs.pets.list) {
  dogs.pets.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-deeper-nested-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should still reject when the selected readonly property
// hides a nullable mutable array behind two nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface OuterBox<T> {
  inner: InnerBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: {
    inner: {
      list: [{ name: "Rex", breed: "Lab" }],
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.inner.list) {
  animals.pets.inner.list.push({ name: "Milo" });
}
if (dogs.pets.inner.list) {
  dogs.pets.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-deeper-nested-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// hides a nullable mutable array behind two nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface OuterBox<T> {
  inner: InnerBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: {
    inner: {
      list: [{ name: "Rex", breed: "Lab" }],
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.inner.list) {
  animals.pets.inner.list.push({ name: "Milo" });
}
if (dogs.pets.inner.list) {
  dogs.pets.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should still reject when the selected readonly property
// hides a nullable mutable array behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// hides a nullable mutable array behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-nested-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should still reject when the selected readonly property
// is an object whose nested field narrows to a nullable mutable Map.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: Map<string, T> | null;
}

interface Box<T> {
  pets: PetBox<T>;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: {
    list: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.set("milo", { name: "Milo" });
}
if (dogs.pets.list) {
  dogs.pets.list.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-pick-nested-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly<Pick<...>> should still reject when the selected readonly property
// is an object whose nested field narrows to a nullable mutable Set.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: Set<T> | null;
}

interface Box<T> {
  pets: PetBox<T>;
}

type AnimalPetBox = Readonly<Pick<Box<Animal>, "pets">>;
type DogPetBox = Readonly<Pick<Box<Dog>, "pets">>;

const dogs: DogPetBox = {
  pets: {
    list: new Set([{ name: "Rex", breed: "Lab" }]),
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.add({ name: "Milo" });
}
if (dogs.pets.list) {
  for (const pet of dogs.pets.list) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'utility-readonly-omit-nested-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is an object whose nested field narrows to a nullable mutable Map.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: Map<string, T> | null;
}

interface Box<T> {
  pets: PetBox<T>;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: {
    list: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.set("milo", { name: "Milo" });
}
if (dogs.pets.list) {
  dogs.pets.list.get("milo")?.breed;
}
`,
  ),
  fixture(
    'utility-readonly-omit-nested-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Direct Readonly<Omit<...>> should still reject when the readonly property
// is an object whose nested field narrows to a nullable mutable Set.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface PetBox<T> {
  list: Set<T> | null;
}

interface Box<T> {
  pets: PetBox<T>;
  tag: string;
}

type AnimalPetBox = Readonly<Omit<Box<Animal>, "tag">>;
type DogPetBox = Readonly<Omit<Box<Dog>, "tag">>;

const dogs: DogPetBox = {
  pets: {
    list: new Set([{ name: "Rex", breed: "Lab" }]),
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.list) {
  animals.pets.list.add({ name: "Milo" });
}
if (dogs.pets.list) {
  for (const pet of dogs.pets.list) {
    pet.breed;
  }
}
`,
  ),
  fixture(
    'user-defined-readonly-omit-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// An alias-equivalent user-defined readonly+omit shape should reject for the
// same mutable-array reason, showing this is shape-based rather than
// utility-name based.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
  tag: string;
}

type StripTag<T extends { tag: string }> = {
  [K in Exclude<keyof T, "tag">]: T[K];
};

type Freeze<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = Freeze<StripTag<Box<Animal>>>;
type DogPetBox = Freeze<StripTag<Box<Dog>>>;

const dogs: DogPetBox = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: AnimalPetBox = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'user-defined-readonly-omit-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+omit shape should still reject
// when a nullable mutable array is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
  tag: string;
}

type StripTag<T extends { tag: string }> = {
  [K in Exclude<keyof T, "tag">]: T[K];
};

type Freeze<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = Freeze<StripTag<Box<Animal>>>;
type DogPetBox = Freeze<StripTag<Box<Dog>>>;

const dogs: DogPetBox = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-pick-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+pick shape should still reject
// when a nullable mutable array is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
  tag: string;
}

type PickPets<T extends { pets: unknown }> = {
  [K in Extract<keyof T, "pets">]: T[K];
};

type Freeze<T> = {
  readonly [K in keyof T]: T[K];
};

type AnimalPetBox = Freeze<PickPets<Box<Animal>>>;
type DogPetBox = Freeze<PickPets<Box<Dog>>>;

const dogs: DogPetBox = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: AnimalPetBox = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-partial-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+partial shape should still reject
// when a nullable mutable array is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
}

type ReadonlyPartial<T> = {
  readonly [K in keyof T]?: T[K];
};

const dogs: ReadonlyPartial<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: ReadonlyPartial<Box<Animal>> = dogs;
if (animals.pets?.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets?.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-required-three-layer-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+required shape should still reject
// when a nullable mutable array is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: T[] | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets?: OuterBox<T>;
}

type ReadonlyRequired<T> = {
  readonly [K in keyof T]-?: T[K];
};

const dogs: ReadonlyRequired<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: [{ name: "Rex", breed: "Lab" }],
      },
    },
  },
};

const animals: ReadonlyRequired<Box<Animal>> = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.push({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list[1]!.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-partial-three-layer-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+partial shape should still reject
// when a nullable mutable Map is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: Map<string, T> | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
}

type ReadonlyPartial<T> = {
  readonly [K in keyof T]?: T[K];
};

const dogs: ReadonlyPartial<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
      },
    },
  },
};

const animals: ReadonlyPartial<Box<Animal>> = dogs;
if (animals.pets?.middle.inner.list) {
  animals.pets.middle.inner.list.set("milo", { name: "Milo" });
}
if (dogs.pets?.middle.inner.list) {
  dogs.pets.middle.inner.list.get("milo")?.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-partial-three-layer-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+partial shape should still reject
// when a nullable mutable Set is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: Set<T> | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets: OuterBox<T>;
}

type ReadonlyPartial<T> = {
  readonly [K in keyof T]?: T[K];
};

const dogs: ReadonlyPartial<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: new Set([{ name: "Rex", breed: "Lab" }]),
      },
    },
  },
};

const animals: ReadonlyPartial<Box<Animal>> = dogs;
if (animals.pets?.middle.inner.list) {
  animals.pets.middle.inner.list.add({ name: "Milo" });
}
if (dogs.pets?.middle.inner.list) {
  Array.from(dogs.pets.middle.inner.list)[1]?.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-required-three-layer-nullable-map-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+required shape should still reject
// when a nullable mutable Map is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: Map<string, T> | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets?: OuterBox<T>;
}

type ReadonlyRequired<T> = {
  readonly [K in keyof T]-?: T[K];
};

const dogs: ReadonlyRequired<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: new Map([["rex", { name: "Rex", breed: "Lab" }]]),
      },
    },
  },
};

const animals: ReadonlyRequired<Box<Animal>> = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.set("milo", { name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  dogs.pets.middle.inner.list.get("milo")?.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-required-three-layer-nullable-set-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// An alias-equivalent user-defined readonly+required shape should still reject
// when a nullable mutable Set is hidden behind three nested object layers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface InnerBox<T> {
  list: Set<T> | null;
}

interface MiddleBox<T> {
  inner: InnerBox<T>;
}

interface OuterBox<T> {
  middle: MiddleBox<T>;
}

interface Box<T> {
  pets?: OuterBox<T>;
}

type ReadonlyRequired<T> = {
  readonly [K in keyof T]-?: T[K];
};

const dogs: ReadonlyRequired<Box<Dog>> = {
  pets: {
    middle: {
      inner: {
        list: new Set([{ name: "Rex", breed: "Lab" }]),
      },
    },
  },
};

const animals: ReadonlyRequired<Box<Animal>> = dogs;
if (animals.pets.middle.inner.list) {
  animals.pets.middle.inner.list.add({ name: "Milo" });
}
if (dogs.pets.middle.inner.list) {
  Array.from(dogs.pets.middle.inner.list)[1]?.breed;
}
`,
  ),
  fixture(
    'named-writable-object-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Named writable object wrappers should still be invariant in soundscript.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface AnimalBox {
  pet: Animal;
}

interface DogBox {
  pet: Dog;
}

const dogs: DogBox = { pet: { name: "Rex", breed: "Lab" } };
const animals: AnimalBox = dogs;
animals.pet = { name: "Milo" };
dogs.pet.breed;
`,
  ),
  fixture(
    'utility-partial-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Partial preserves utility-wrapper writability here, so it should still
// reject covariant broadening through that wrapped property.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  value: T;
}

const dogs: Partial<Box<Dog>> = {
  value: { name: "Rex", breed: "Lab" },
};

const animals: Partial<Box<Animal>> = dogs;
animals.value = { name: "Milo" };
dogs.value?.breed;
`,
  ),
  fixture(
    'utility-readonly-partial-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Direct Readonly<Partial<...>> should preserve safe covariance for a
// readonly optional non-container object payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet: T;
}

const dogs: Readonly<Partial<Box<Dog>>> = {
  pet: { name: "Rex", breed: "Lab" },
};

const animals: Readonly<Partial<Box<Animal>>> = dogs;
const animalName = animals.pet?.name;
`,
  ),
  fixture(
    'utility-readonly-partial-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Partial<...>> should still reject when the readonly optional
// property payload remains a mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
}

const dogs: Readonly<Partial<Box<Dog>>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: Readonly<Partial<Box<Animal>>> = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-partial-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Partial<...>> should still reject when the readonly optional
// property payload remains a top-level nullable mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[] | null;
}

const dogs: Readonly<Partial<Box<Dog>>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: Readonly<Partial<Box<Animal>>> = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'utility-readonly-required-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// Direct Readonly<Required<...>> should preserve safe covariance for a
// readonly required non-container object payload.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet?: T;
}

const dogs: Readonly<Required<Box<Dog>>> = {
  pet: { name: "Rex", breed: "Lab" },
};

const animals: Readonly<Required<Box<Animal>>> = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'utility-readonly-required-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Required<...>> should still reject when the readonly
// required property payload remains a mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: T[];
}

const dogs: Readonly<Required<Box<Dog>>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: Readonly<Required<Box<Animal>>> = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'utility-readonly-required-nullable-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// Direct Readonly<Required<...>> should still reject when the readonly
// required property payload remains a top-level nullable mutable array.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: T[] | null;
}

const dogs: Readonly<Required<Box<Dog>>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: Readonly<Required<Box<Animal>>> = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'user-defined-readonly-required-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// A user-defined readonly+required mapped type should accept the same safe
// readonly required object-property relation, showing this is shape-based.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet?: T;
}

type ReadonlyRequired<T> = {
  readonly [K in keyof T]-?: T[K];
};

const dogs: ReadonlyRequired<Box<Dog>> = {
  pet: { name: "Rex", breed: "Lab" },
};

const animals: ReadonlyRequired<Box<Animal>> = dogs;
const animalName = animals.pet.name;
`,
  ),
  fixture(
    'user-defined-readonly-required-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// A user-defined readonly+required mapped type should reject for the same
// mutable-array reason, showing the owned check is shape-based.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets?: T[];
}

type ReadonlyRequired<T> = {
  readonly [K in keyof T]-?: T[K];
};

const dogs: ReadonlyRequired<Box<Dog>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: ReadonlyRequired<Box<Animal>> = dogs;
animals.pets.push({ name: "Milo" });
dogs.pets[1]!.breed;
`,
  ),
  fixture(
    'user-defined-readonly-partial-object-property-covariance.accept.ts',
    `// @sound-test: accept
//
// A user-defined readonly+partial mapped type should accept the same safe
// readonly optional object-property relation, showing this is shape-based.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pet: T;
}

type ReadonlyPartial<T> = {
  readonly [K in keyof T]?: T[K];
};

const dogs: ReadonlyPartial<Box<Dog>> = {
  pet: { name: "Rex", breed: "Lab" },
};

const animals: ReadonlyPartial<Box<Animal>> = dogs;
const animalName = animals.pet?.name;
`,
  ),
  fixture(
    'user-defined-readonly-partial-array-payload-property-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
//
// A user-defined readonly+partial mapped type should reject for the same
// mutable-array reason, showing the owned check is shape-based.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Box<T> {
  pets: T[];
}

type ReadonlyPartial<T> = {
  readonly [K in keyof T]?: T[K];
};

const dogs: ReadonlyPartial<Box<Dog>> = {
  pets: [{ name: "Rex", breed: "Lab" }],
};

const animals: ReadonlyPartial<Box<Animal>> = dogs;
if (animals.pets) {
  animals.pets.push({ name: "Milo" });
}
if (dogs.pets) {
  dogs.pets[1]!.breed;
}
`,
  ),
  fixture(
    'accessor-write-type-invariance.reject.ts',
    `// @sound-test: reject
//
// Writable class properties should be invariant in soundscript.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Kennel {
  value: Dog = { name: "Rex", breed: "Lab" };
}

const kennel = new Kennel();
const widened: { value: Animal } = kennel;
widened.value = { name: "Milo" };
kennel.value.breed;
`,
  ),
  fixture(
    'generic-class-wrapper-property-laundering.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Generic class wrappers should not launder writable property covariance
// through their type arguments.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }
}

const dogs = new Box<Dog>({ name: "Rex", breed: "Lab" });
const animals: Box<Animal> = dogs;
animals.value = { name: "Milo" };
dogs.value.breed;
`,
  ),
  fixture(
    'generic-class-hash-private-wrapper-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ECMAScript #private-backed generic class wrappers should still require
// exact matching type arguments, even when the public surface does not expose T.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

const dogs = new Box<Dog>({ name: "Rex", breed: "Lab" });
const animals: Box<Animal> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-wrapper-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly wrappers should not launder differing generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

interface ReadonlyHolder<T> {
  readonly value: T;
}

const dogs: ReadonlyHolder<Box<Dog>> = {
  value: new Box<Dog>({ name: "Rex", breed: "Lab" }),
};
const animals: ReadonlyHolder<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-nullable-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Nullable wrappers should still reject differing generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

const dogs: Box<Dog> | null = new Box<Dog>({ name: "Rex", breed: "Lab" });
const animals: Box<Animal> | null = dogs;
`,
  ),
  fixture(
    'generic-class-subclass-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Subclasses should not bypass exact-match generic class relations inherited
// from a generic base class.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

class DogBox extends Box<Dog> {}

const dogs = new DogBox({ name: "Rex", breed: "Lab" });
const animals: Box<Animal> = dogs;
`,
  ),
  fixture(
    'generic-class-union-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Union wrappers should not launder differing generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

const dogs: Box<Dog> | string = new Box<Dog>({ name: "Rex", breed: "Lab" });
const animals: Box<Animal> | string = dogs;
`,
  ),
  fixture(
    'generic-class-intersection-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Intersection wrappers should not launder differing generic class
// instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

class DogBoxClass extends Box<Dog> {
  readonly tag = "kennel";
}

class AnimalBoxClass extends Box<Animal> {
  readonly tag = "kennel";
}

type DogBox = Box<Dog> & { readonly tag: string };
type AnimalBox = Box<Animal> & { readonly tag: string };

const dogs: DogBox = new DogBoxClass({ name: "Rex", breed: "Lab" });

const animals: AnimalBox = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-array-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly arrays should not treat differing generic class instantiations as
// covariant element relations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

const dogs: ReadonlyArray<Box<Dog>> = [new Box<Dog>({ name: "Rex", breed: "Lab" })];
const animals: ReadonlyArray<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-promise-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Promise should not launder differing generic class instantiations through its
// covariant fulfilled-value position.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Promise<Box<Dog>>;
const animals: Promise<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-promiselike-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// PromiseLike wrappers are banned before generic exact-match checks apply.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: PromiseLike<Box<Dog>>;
const animals: PromiseLike<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-set-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadonlySet should not treat differing generic class instantiations as
// covariant element relations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadonlySet<Box<Dog>>;
const animals: ReadonlySet<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-set-view-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mutable Set values passed through a ReadonlySet view should still preserve
// exact-match generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Set<Box<Dog>>;
const animals: ReadonlySet<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-map-value-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadonlyMap should not treat differing generic class instantiations as
// covariant value relations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadonlyMap<string, Box<Dog>>;
const animals: ReadonlyMap<string, Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-map-view-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mutable Map values viewed through ReadonlyMap should still preserve exact
// generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Map<string, Box<Dog>>;
const animals: ReadonlyMap<string, Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-map-key-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadonlyMap key positions should also preserve exact generic class
// instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadonlyMap<Box<Dog>, string>;
const animals: ReadonlyMap<Box<Animal>, string> = dogs;
`,
  ),
  fixture(
    'generic-class-promise-readonly-array-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Nested readonly producer wrappers should still preserve exact generic class
// instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Promise<ReadonlyArray<Box<Dog>>>;
const animals: Promise<ReadonlyArray<Box<Animal>>> = dogs;
`,
  ),
  fixture(
    'promise-mutable-array-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Promise should not launder mutable array covariance through its fulfilled
// value type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Promise<Dog[]>;
const animals: Promise<Animal[]> = dogs;
`,
  ),
  fixture(
    'promise-mutable-map-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Promise should not launder mutable Map variance through its fulfilled value
// type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Promise<Map<string, Dog>>;
const animals: Promise<Map<string, Animal>> = dogs;
`,
  ),
  fixture(
    'promise-mutable-set-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Promise should not launder mutable Set variance through its fulfilled value
// type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Promise<Set<Dog>>;
const animals: Promise<Set<Animal>> = dogs;
`,
  ),
  fixture(
    'arraylike-covariance.accept.ts',
    `// @sound-test: accept
//
// ArrayLike should be declaration-driven covariant through its readonly index surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: ArrayLike<Dog>;
const animals: ArrayLike<Animal> = dogs;
`,
  ),
  fixture(
    'generic-class-arraylike-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ArrayLike should not launder differing generic class instantiations through
// its readonly element surface.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ArrayLike<Box<Dog>>;
const animals: ArrayLike<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'arraylike-mutable-array-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ArrayLike should also preserve nested mutable payload variance.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: ArrayLike<Dog[]>;
const animals: ArrayLike<Animal[]> = dogs;
`,
  ),
  fixture(
    'generic-class-promise-settled-result-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// PromiseSettledResult should preserve exact generic class instantiations in
// its fulfilled branch.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: PromiseSettledResult<Box<Dog>>;
const animals: PromiseSettledResult<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-iterator-result-yield-branch-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// IteratorResult should preserve exact generic class instantiations in its
// yielded branch.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: IteratorResult<Box<Dog>, number>;
const animals: IteratorResult<Box<Animal>, number> = dogs;
`,
  ),
  fixture(
    'generic-class-iterator-result-return-branch-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// IteratorResult should preserve exact generic class instantiations in its
// return branch.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: IteratorResult<number, Box<Dog>>;
const animals: IteratorResult<number, Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-iterator-result-both-branches-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// IteratorResult should preserve exact generic class instantiations across
// both of its branches.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: IteratorResult<Box<Dog>, Box<Dog>>;
const animals: IteratorResult<Box<Animal>, Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-read-result-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamReadResult should preserve exact generic class instantiations
// across its union branches.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStreamReadResult<Box<Dog>>;
const animals: ReadableStreamReadResult<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-promise-readable-stream-read-result-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Outer Promise wrappers should not launder differing generic class
// instantiations through ReadableStreamReadResult.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Promise<ReadableStreamReadResult<Box<Dog>>>;
const animals: Promise<ReadableStreamReadResult<Box<Animal>>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-array-readable-stream-read-result-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly arrays should not launder differing generic class instantiations
// through ReadableStreamReadResult.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: readonly ReadableStreamReadResult<Box<Dog>>[];
const animals: readonly ReadableStreamReadResult<Box<Animal>>[] = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-reader-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamReader should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStreamReader<Box<Dog>>;
const animals: ReadableStreamReader<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-default-reader-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamDefaultReader should preserve exact generic class
// instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStreamDefaultReader<Box<Dog>>;
const animals: ReadableStreamDefaultReader<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-controller-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamController should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStreamController<Box<Dog>>;
const animals: ReadableStreamController<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-default-controller-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamDefaultController should preserve exact generic class
// instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStreamDefaultController<Box<Dog>>;
const animals: ReadableStreamDefaultController<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'iterator-result-yield-mutable-array-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// IteratorResult should also recurse into nested mutable payloads in its yield
// branch.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: IteratorResult<Dog[], number>;
const animals: IteratorResult<Animal[], number> = dogs;
`,
  ),
  fixture(
    'iterator-result-return-mutable-set-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// IteratorResult should also recurse into nested mutable payloads in its
// return branch.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: IteratorResult<number, Set<Dog>>;
const animals: IteratorResult<number, Set<Animal>> = dogs;
`,
  ),
  fixture(
    'readable-stream-read-result-mutable-array-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStreamReadResult should also recurse into nested mutable payloads.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: ReadableStreamReadResult<Dog[]>;
const animals: ReadableStreamReadResult<Animal[]> = dogs;
`,
  ),
  fixture(
    'readable-stream-covariance.accept.ts',
    `// @sound-test: accept
//
// ReadableStream should be declaration-driven covariant through the vendored
// stream reader/result surfaces.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: ReadableStream<Dog>;
const animals: ReadableStream<Animal> = dogs;
`,
  ),
  fixture(
    'readable-stream-mutable-array-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStream should still recurse into nested mutable payloads.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: ReadableStream<Dog[]>;
const animals: ReadableStream<Animal[]> = dogs;
`,
  ),
  fixture(
    'generic-class-readable-stream-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// ReadableStream should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadableStream<Box<Dog>>;
const animals: ReadableStream<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-promise-readable-stream-reader-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Promise should not launder exact-match generic class instantiations through
// ReadableStreamReader wrappers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: Promise<ReadableStreamReader<Box<Dog>>>;
const animals: Promise<ReadableStreamReader<Box<Animal>>> = dogs;
`,
  ),
  fixture(
    'generic-class-readonly-array-readable-stream-controller-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly array shells should still recurse through ReadableStreamController
// wrappers.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  isReady(): boolean {
    return this.#value !== undefined;
  }
}

// #[extern]
declare const dogs: ReadonlyArray<ReadableStreamController<Box<Dog>>>;
const animals: ReadonlyArray<ReadableStreamController<Box<Animal>>> = dogs;
`,
  ),
  fixture(
    'generic-class-array-iterator-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Concrete iterator shells should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: ArrayIterator<Box<Dog>>;
const animals: ArrayIterator<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-set-iterator-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// SetIterator should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: SetIterator<Box<Dog>>;
const animals: SetIterator<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-map-iterator-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// MapIterator should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: MapIterator<Box<Dog>>;
const animals: MapIterator<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-string-iterator-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// StringIterator should preserve exact generic class instantiations.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: StringIterator<Box<Dog>>;
const animals: StringIterator<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-user-iterator-interface-shell-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// User-defined interface shells over stdlib iterators should inherit the same
// exact-match constraints.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

interface Iter<T> extends ArrayIterator<T> {}

// #[extern]
declare const dogs: Iter<Box<Dog>>;
const animals: Iter<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'generic-class-user-iterator-alias-shell-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// User-defined alias shells over stdlib iterators should inherit the same
// exact-match constraints.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

type Iter<T> = ArrayIterator<T>;

// #[extern]
declare const dogs: Iter<Box<Dog>>;
const animals: Iter<Box<Animal>> = dogs;
`,
  ),
  fixture(
    'typescript-private-member-policy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// TypeScript private members are outside the supported sound subset.
//
class SecretBox {
  private value = 1;

  read(): number {
    return this.value;
  }
}

const box = new SecretBox();
box.read();
`,
  ),
  fixture(
    'typescript-protected-member-policy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// TypeScript protected members are outside the supported sound subset.
//
class Base {
  protected value = 1;
}

class Derived extends Base {
  read(): number {
    return this.value;
  }
}

const box = new Derived();
box.read();
`,
  ),
  fixture(
    'typescript-private-constructor-policy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// TypeScript private constructors are outside the supported sound subset.
//
class SecretBox {
  private constructor() {}

  static create(): SecretBox {
    return new SecretBox();
  }
}

SecretBox.create();
`,
  ),
  fixture(
    'typescript-protected-constructor-policy.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1022
//
// TypeScript protected constructors are outside the supported sound subset.
//
class Base {
  protected constructor() {}
}

class Derived extends Base {
  constructor() {
    super();
  }
}

new Derived();
`,
  ),
  fixture(
    'covariant-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
// @sound-note: 'Dog[]' cannot be widened to 'Animal[]' because writes through the target could push values the source array does not allow.
// @sound-hint: Use a readonly array, copy into a new array, or keep the exact element type.
//
// Mutable arrays are invariant because widening creates a write hole.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];
const animals: Animal[] = dogs;
animals.push({ name: "Milo" });
dogs[1]!.breed;
`,
  ),
  fixture(
    'argument-site-covariant-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mutable array widening should also be rejected when it happens through a
// function argument site rather than a local assignment.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function takeAnimals(xs: Animal[]): void {
  xs.push({ name: "Milo" });
}

const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];
takeAnimals(dogs);
dogs[1]!.breed;
`,
  ),
  fixture(
    'rest-parameter-fresh-object-literal-alias-smuggling.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Rest parameters should also reject caller-retained wrappers that launder an
// existing mutable alias through a wider property type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replacePets(...boxes: [{ pet: Animal }]): void {
  boxes[0].pet = { name: "Milo" };
}

const dog: Dog = { name: "Rex", breed: "Lab" };
const box: { pet: Dog } = { pet: dog };
replacePets(box);
box.pet.breed;
`,
  ),
  fixture(
    'spread-argument-mutable-tuple-alias-smuggling.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Spread arguments from a mutable tuple should still reject when they launder
// a mutable alias through a wider property type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replacePet(box: { pet: Animal }): void {
  box.pet = { name: "Milo" };
}

const tuple: [{ pet: Dog }] = [{ pet: { name: "Rex", breed: "Lab" } }];
replacePet(...tuple);
tuple[0].pet.breed;
`,
  ),
  fixture(
    'spread-argument-readonly-tuple-alias-smuggling.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Readonly spread wrappers should still reject when they transport a mutable
// caller-visible alias through a wider property type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replacePet(box: { pet: Animal }): void {
  box.pet = { name: "Milo" };
}

const dog: Dog = { name: "Rex", breed: "Lab" };
const box: { pet: Dog } = { pet: dog };
const tuple: readonly [{ pet: Dog }] = [box];
replacePet(...tuple);
box.pet.breed;
`,
  ),
  fixture(
    'rest-parameter-variadic-tuple-later-slot.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Variadic rest tuples should check every argument that lands in the variadic
// segment, not just the first one.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replacePets(...args: [number, ...{ pet: Animal }[]]): void {
  args[2]!.pet = { name: "Milo" };
}

const safeBox: { pet: Animal } = { pet: { name: "Spot" } };
const dog: Dog = { name: "Rex", breed: "Lab" };
const badBox: { pet: Dog } = { pet: dog };
replacePets(0, safeBox, badBox);
badBox.pet.breed;
`,
  ),
  fixture(
    'rest-parameter-variadic-tuple-fixed-suffix.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Variadic rest tuples with a fixed suffix should check the tail slot against
// the suffix type rather than repeating the variadic element type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replaceTail(...args: [number, ...string[], { pet: Animal }]): void {
  const tail = args[args.length - 1];
  if (tail !== undefined && typeof tail !== "string" && typeof tail !== "number") {
    tail.pet = { name: "Milo" };
  }
}

const dog: Dog = { name: "Rex", breed: "Lab" };
const badBox: { pet: Dog } = { pet: dog };
replaceTail(0, "safe", badBox);
badBox.pet.breed;
`,
  ),
  fixture(
    'spread-argument-variadic-tuple-later-slot.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Variadic tuple spreads should keep checking later runtime slots when a
// caller-visible tail element can slide past additional runtime rest values.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replaceTail(...args: [number, ...string[], { pet: Animal }]): void {
  const tail = args[args.length - 1];
  if (tail !== undefined && typeof tail !== "string" && typeof tail !== "number") {
    tail.pet = { name: "Milo" };
  }
}

// #[extern]
declare const args: [number, ...string[], { pet: Dog }];
replaceTail(...args);

const tail = args[args.length - 1];
if (tail !== undefined && typeof tail !== "string" && typeof tail !== "number") {
  tail.pet.breed;
}
`,
  ),
  fixture(
    'spread-argument-variadic-tuple-nonfinal-suffix.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Variadic tuple spread suffixes should still be checked when the spread is
// followed by later syntactic arguments.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replaceTail(...args: [number, ...string[], { pet: Animal }, boolean]): void {
  const tail = args[args.length - 2];
  if (
    tail !== undefined &&
    typeof tail !== "string" &&
    typeof tail !== "number" &&
    typeof tail !== "boolean"
  ) {
    tail.pet = { name: "Milo" };
  }
}

// #[extern]
declare const args: [number, ...string[], { pet: Dog }];
replaceTail(...args, false);

const tail = args[args.length - 1];
if (tail !== undefined && typeof tail !== "string" && typeof tail !== "number") {
  tail.pet.breed;
}
`,
  ),
  fixture(
    'argument-after-array-spread-fixed-suffix.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Ordinary arguments that follow an unknown-length spread should still resolve
// against fixed suffix slots rather than being treated as part of the variadic
// middle segment.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replaceTail(...args: [number, ...string[], { pet: Animal }, boolean]): void {
  const tail = args[args.length - 2];
  if (
    tail !== undefined &&
    typeof tail !== "string" &&
    typeof tail !== "number" &&
    typeof tail !== "boolean"
  ) {
    tail.pet = { name: "Milo" };
  }
}

// #[extern]
declare const strings: string[];
// #[extern]
declare const dog: Dog;
const badBox: { pet: Dog } = { pet: dog };
replaceTail(0, ...strings, badBox, false);
badBox.pet.breed;
`,
  ),
  fixture(
    'fresh-array-literal-alias-smuggling.reject.ts',
    `// @sound-test: reject
//
// A fresh array literal is still unsound if it widens an existing mutable alias.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dog: Dog = { name: "Rex", breed: "Lab" };
const animals: Animal[] = [dog];
animals[0] = { name: "Milo" };
dog.breed;
`,
  ),
  fixture(
    'argument-site-fresh-object-literal-alias-smuggling.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// A fresh object literal at an argument site is still unsound when it launders
// an existing mutable alias through a wider property type.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function replacePet(box: { pet: Animal }): void {
  box.pet = { name: "Milo" };
}

const dog: Dog = { name: "Rex", breed: "Lab" };
replacePet({ pet: dog });
dog.breed;
`,
  ),
  fixture(
    'mutable-index-signature-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Writable string index signatures are invariant in soundscript."
// @sound-note: The target can write 'Animal' values, but the source only accepts 'Dog'.
// @sound-hint: Use a readonly index signature, copy into a fresh object, or keep the exact value type.
//
// Mutable index signatures are invariant because writes can break the source.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs: { [key: string]: Dog } = {
  rex: { name: "Rex", breed: "Shepherd" },
};
const animals: { [key: string]: Animal } = dogs;
animals["milo"] = { name: "Milo" };
dogs["milo"]!.breed;
`,
  ),
  fixture(
    'mutable-symbol-index-signature-covariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Writable symbol index signatures are invariant in soundscript."
// @sound-note: The target can write 'Animal' values, but the source only accepts 'Dog'.
// @sound-hint: Use a readonly index signature, copy into a fresh object, or keep the exact value type.
//
// Mutable symbol index signatures are invariant because writes can break the source.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: { [key: string]: string; [key: symbol]: Dog };
const animals: { [key: string]: string; [key: symbol]: Animal } = dogs;
`,
  ),
  fixture(
    'fresh-object-literal-alias-smuggling.reject.ts',
    `// @sound-test: reject
//
// A fresh object literal is still unsound if it widens an existing mutable alias.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dog: Dog = { name: "Rex", breed: "Lab" };
const box: { pet: Animal } = { pet: dog };
box.pet = { name: "Milo" };
dog.breed;
`,
  ),
  fixture(
    'method-parameter-contravariance.reject.ts',
    `// @sound-test: reject
//
// Function-typed mutable members must be contravariant in their parameters.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type AnimalHandler = {
  fn: (value: Animal) => void;
};

const dogHandler: { fn: (value: Dog) => void } = {
  fn(value: Dog) {
    value.breed;
  },
};

const widened: AnimalHandler = dogHandler;
`,
  ),
  fixture(
    'method-signature-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Method syntax should not bypass callable parameter contravariance.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type AnimalHandler = {
  fn(value: Animal): void;
};

const dogHandler: { fn(value: Dog): void } = {
  fn(value: Dog) {
    value.breed;
  },
};

const widened: AnimalHandler = dogHandler;
`,
  ),
  fixture(
    'class-method-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Class instance types are nominal in soundscript."
//
// Same-shape class handlers now reject earlier because class targets are nominal.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class AnimalHandler {
  fn(value: Animal): void {
    value.name;
  }
}

class DogHandler {
  fn(value: Dog): void {
    value.breed;
  }
}

const widened: AnimalHandler = new DogHandler();
`,
  ),
  fixture(
    'optional-method-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Optional methods should not bypass callable parameter contravariance through
// their implicit undefined wrapper.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type AnimalHandler = {
  fn?(value: Animal): void;
};

const dogHandler: { fn?(value: Dog): void } = {
  fn(value: Dog) {
    value.breed;
  },
};

const widened: AnimalHandler = dogHandler;
`,
  ),
  fixture(
    'intersection-method-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Method variance should not be laundered through an intersection wrapper.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type Source = { fn(value: Dog): void } & { readonly tag: string };
type Target = { fn(value: Animal): void } & { readonly tag: string };

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'union-member-wrapper-probe.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Union wrappers should not launder callable member variance through one
// constituent while widening another constituent.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type Box<T> = { fn(value: T): void };

type Source = Box<Dog> | { readonly noop: true };
type Target = Box<Animal> | { readonly noop: true };

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'constructor-property-wrapper-probe.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Writable property 'ctor' is invariant in soundscript."
//
// Constructor-valued properties should not be laundered through union wrappers.
//
class Animal {
  name: string = "";
}

class Dog extends Animal {
  breed: string = "";
}

type Source = { ctor: typeof Dog } | { readonly noop: true };
type Target = { ctor: typeof Animal } | { readonly noop: true };

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'constructor-property-intersection-probe.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Writable property 'ctor' is invariant in soundscript."
//
// Constructor-valued properties should not be laundered through intersection
// wrappers either.
//
class Animal {
  name: string = "";
}

class Dog extends Animal {
  breed: string = "";
}

type Source = { ctor: typeof Dog } & { readonly tag: string };
type Target = { ctor: typeof Animal } & { readonly tag: string };

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'pick-union-callable-wrapper-probe.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Utility wrappers should not reopen the union-member callable laundering hole.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type Base<T> = { fn(value: T): void; extra: string };

type Source = Pick<Base<Dog>, "fn"> | { readonly noop: true };
type Target = Pick<Base<Animal>, "fn"> | { readonly noop: true };

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'readonly-method-wrapper-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Readonly utility wrappers should preserve method parameter checking.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type Source = Readonly<{ fn(value: Dog): void }>;
type Target = Readonly<{ fn(value: Animal): void }>;

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'pick-method-wrapper-parameter-contravariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Callable parameter types are contravariant in soundscript."
//
// Pick-wrapped method surfaces should not hide callable variance.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type Base<T> = {
  fn(value: T): void;
  tag: string;
};

type Source = Pick<Base<Dog>, "fn">;
type Target = Pick<Base<Animal>, "fn">;

// #[extern]
declare const source: Source;
const widened: Target = source;
`,
  ),
  fixture(
    'covariant-map.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Map values are invariant in soundscript."
// @sound-note: 'Map<string, Dog>' cannot be widened to 'Map<string, Animal>' because writes through the target map could use incompatible keys or values.
// @sound-hint: Use ReadonlyMap, copy into a new Map, or keep the exact key and value types.
//
// Mutable Map is invariant because set can write a wider value through an alias.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs = new Map<string, Dog>([["rex", { name: "Rex", breed: "Lab" }]]);
const animals: Map<string, Animal> = dogs;
animals.set("milo", { name: "Milo" });
dogs.get("milo")?.breed;
`,
  ),
  fixture(
    'covariant-set.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable Set values are invariant in soundscript."
// @sound-note: 'Set<Dog>' cannot be widened to 'Set<Animal>' because writes through the target set could add incompatible values.
// @sound-hint: Use ReadonlySet, copy into a new Set, or keep the exact element type.
//
// Mutable Set is invariant because add can inject a wider value through an alias.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

const dogs = new Set<Dog>([{ name: "Rex", breed: "Lab" }]);
const animals: Set<Animal> = dogs;
animals.add({ name: "Milo" });

for (const dog of dogs) {
  dog.breed;
}
`,
  ),
  fixture(
    'rest-parameter-contravariance.reject.ts',
    `// @sound-test: reject
//
// Rest parameters are contravariant in soundscript.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type AnimalSink = (...xs: Animal[]) => void;

const dogSink: (...dogs: Dog[]) => void = (...dogs: Dog[]) => {
  dogs[0]!.breed;
};

const sink: AnimalSink = dogSink;
`,
  ),
  fixture(
    'constructor-parameter-contravariance.reject.ts',
    `// @sound-test: reject
//
// Constructor parameter types should be contravariant in soundscript.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type AnimalCtor = new (x: Animal) => unknown;

class NeedsDog {
  constructor(d: Dog) {
    d.breed;
  }
}

const ctor: AnimalCtor = NeedsDog;
`,
  ),
  fixture(
    'overload-set-assignability.reject.ts',
    `// @sound-test: reject
//
// Overload sets should be assigned soundly as a whole, not by accepting an
// unsoundly narrow overload in one branch.

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

interface Source {
  (x: Dog): void;
  (x: number): void;
}

interface Target {
  (x: Animal): void;
  (x: number): void;
}

// #[extern]
declare const source: Source;
const target: Target = source;
`,
  ),
  fixture(
    'return-site-covariant-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mutable array widening should also be rejected when it happens through an
// annotated return site.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

function widen(xs: Dog[]): Animal[] {
  return xs;
}

const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];
const animals = widen(dogs);
animals.push({ name: "Milo" });
dogs[1]!.breed;
`,
  ),
  fixture(
    'callable-return-covariant-array.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019 "Generic parameter 'T' of 'Array' is invariant in soundscript."
//
// Callable return types should not launder mutable array covariance.
//
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

type DogFactory = () => Dog[];
type AnimalFactory = () => Animal[];

// #[extern]
declare const makeDogs: DogFactory;
const widened: AnimalFactory = makeDogs;
`,
  ),
  fixture(
    'imported-dts-conditional-alias-method-bivariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Unsupported conditional aliases imported from .d.ts should not fall back to
// bivariant method comparison.
//
// #[interop]
import type { Sink } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogSink: Sink<Dog>;
const animalSink: Sink<Animal> = dogSink;
void animalSink;
`,
    {
      'src/lib.d.ts': `export type Sink<T> = T extends unknown ? { put(value: T): void } : never;`,
    },
  ),
  fixture(
    'imported-dts-conditional-alias-mixed-cell.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Mixed read/write conditional aliases imported from .d.ts should preserve
// invariant assignment.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts':
        `export type Cell<T> = T extends unknown ? { get(): T; set(value: T): void } : never;`,
    },
  ),
  fixture(
    'imported-dts-conditional-alias-generic-class-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported .d.ts conditional aliases should not launder generic class exact
// matching through method parameters.
//
// #[interop]
import type { Sink } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: Sink<Box<Dog>>;
const animals: Sink<Box<Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export type Sink<T> = T extends unknown ? { put(value: T): void } : never;`,
    },
  ),
  fixture(
    'imported-dts-mapped-alias-method-bivariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported .d.ts mapped aliases should not drop back to bivariant cell-style
// method comparison.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts':
        `type RawCell<T> = { get(): T; set(value: T): void }; export type Cell<T> = { [K in keyof RawCell<T>]: RawCell<T>[K] };`,
    },
  ),
  fixture(
    'imported-dts-mapped-alias-generic-class-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported .d.ts mapped aliases should preserve generic class exact matching
// through cell-style method surfaces.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: Cell<Box<Dog>>;
const animals: Cell<Box<Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts':
        `type RawCell<T> = { get(): T; set(value: T): void }; export type Cell<T> = { [K in keyof RawCell<T>]: RawCell<T>[K] };`,
    },
  ),
  fixture(
    'imported-dts-indexed-access-alias-method-bivariance.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported .d.ts indexed-access aliases should not launder method bivariance.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts':
        `interface Pair<T> { cell: { get(): T; set(value: T): void } } export type Cell<T> = Pair<T>["cell"];`,
    },
  ),
  fixture(
    'imported-dts-indexed-access-alias-generic-class-exact-match.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported .d.ts indexed-access aliases should also preserve generic class
// exact matching through cell-style method surfaces.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

class Box<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }
}

// #[extern]
declare const dogs: Cell<Box<Dog>>;
const animals: Cell<Box<Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts':
        `interface Pair<T> { cell: { get(): T; set(value: T): void } } export type Cell<T> = Pair<T>["cell"];`,
    },
  ),
  fixture(
    'imported-dts-annotated-conditional-alias-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Imported .d.ts variance contracts should stay checked rather than becoming a
// trusted escape hatch for unsupported alias shapes.
//
// #[interop]
import type { Sink } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogSink: Sink<Dog>;
const animalSink: Sink<Animal> = dogSink;
void animalSink;
`,
    {
      'src/lib.d.ts': `// #[variance(T: out)]
export type Sink<T> = T extends unknown ? { put(value: T): void } : never;`,
    },
  ),
  fixture(
    'imported-dts-annotated-conditional-cell-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Imported .d.ts variance contracts should also be checked for mixed
// read/write conditional aliases.
//
// #[interop]
import type { Cell } from "./lib";

interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}

// #[extern]
declare const dogs: Cell<Dog>;
const animals: Cell<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `// #[variance(T: out)]
export type Cell<T> = T extends unknown ? { get(): T; set(value: T): void } : never;`,
    },
  ),
  fixture(
    'imported-conditional-method-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Unsupported imported conditional aliases must not fall through to declaration-file
// method bivariance.
//
// #[interop]
import type { Animal, Dog, ConditionalHandler } from "./lib";

// #[extern]
declare const dogs: ConditionalHandler<Dog>;
const animals: ConditionalHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export type ConditionalHandler<T> = T extends unknown ? {
  use(value: T): void;
} : never;
`,
    },
  ),
  fixture(
    'imported-conditional-class-payload-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Unsupported imported conditional aliases must not launder generic-class exact-match
// through declaration-file method returns.
//
// #[interop]
import type { Animal, Dog, ConditionalFactory } from "./lib";

// #[extern]
declare const dogs: ConditionalFactory<Dog>;
const animals: ConditionalFactory<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export type ConditionalFactory<T> = T extends unknown ? {
  get(): Box<T>;
} : never;
`,
    },
  ),
  fixture(
    'imported-mapped-nested-method-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Unsupported imported mapped aliases must not fall through to declaration-file
// nested method bivariance.
//
// #[interop]
import type { Animal, Dog, MappedHandler } from "./lib";

// #[extern]
declare const dogs: MappedHandler<Dog>;
const animals: MappedHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export type MappedHandler<T> = {
  [K in "handler"]: {
    use(value: T): void;
  };
};
`,
    },
  ),
  fixture(
    'imported-indexed-access-method-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Unsupported imported indexed-access aliases must not fall through to declaration-file
// method bivariance.
//
// #[interop]
import type { Animal, Dog, IndexedHandler } from "./lib";

// #[extern]
declare const dogs: IndexedHandler<Dog>;
const animals: IndexedHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface HandlerBox<T> {
  handler: {
    use(value: T): void;
  };
}

export type IndexedHandler<T> = HandlerBox<T>["handler"];
`,
    },
  ),
  fixture(
    'imported-annotated-unsupported-alias-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Imported checked variance contracts must still be rejected when an unsupported alias
// shape overclaims its variance.
//
// #[interop]
import type { Animal, Dog, ConditionalHandler } from "./lib";

// #[extern]
declare const dogs: ConditionalHandler<Dog>;
const animals: ConditionalHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

// #[variance(T: out)]
export type ConditionalHandler<T> = T extends unknown ? {
  use(value: T): void;
} : never;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-method-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should not fall through to
// declaration-file method bivariance.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-generic-class-alias.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should also preserve generic class
// exact matching through method surfaces.
//
// #[interop]
import type { Animal, Dog, Box, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: ReadonlyFactory<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// at direct call sites too, not only at variable declarations.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function takeAnimal(value: ReadonlyHandler<Animal>): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-tuple-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// when they flow through tuple element positions.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: [ReadonlyHandler<Animal>] = [dogs];
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-object-property-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject nested object
// property widening inside annotated literals.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const holder: { current: ReadonlyHandler<Animal> } = { current: dogs };
void holder;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-object-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject nested object
// property widening at call sites.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function takeBox(value: { current: ReadonlyHandler<Animal> }): void {
  void value;
}

takeBox({ current: dogs });
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-object-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject nested object
// property widening at return sites.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function widen(): { current: ReadonlyHandler<Animal> } {
  return { current: dogs };
}

void widen;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching at direct call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

function takeAnimal(value: ReadonlyFactory<Animal>): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-readonly-array-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// through readonly array element positions too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: readonly ReadonlyHandler<Animal>[] = [dogs];
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-promise-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// through Promise wrappers too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: Promise<ReadonlyHandler<Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-union-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// when the alias appears inside a union branch.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> | undefined = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-explicit-generic-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// at explicit generic call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function id<T>(value: T): T {
  return value;
}

const animals = id<ReadonlyHandler<Animal>>(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-promise-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through Promise wrappers too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: Promise<ReadonlyFactory<Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-explicit-generic-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching at explicit generic call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

function id<T>(value: T): T {
  return value;
}

const animals = id<ReadonlyFactory<Animal>>(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-promiselike-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Imported utility aliases should reject PromiseLike wrappers outright.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: PromiseLike<ReadonlyHandler<Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-readonly-set-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// through ReadonlySet element positions too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlySet<ReadonlyHandler<Animal>> = new Set([dogs]);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-readonly-map-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should reject unsound widening
// through ReadonlyMap value positions too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyMap<string, ReadonlyHandler<Animal>> = new Map([["dogs", dogs]]);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-promiselike-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1034
//
// Imported utility aliases should reject PromiseLike wrappers outright.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: PromiseLike<ReadonlyFactory<Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-readonly-set-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through ReadonlySet element positions too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: ReadonlySet<ReadonlyFactory<Animal>> = new Set([dogs]);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-readonly-map-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through ReadonlyMap value positions too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: ReadonlyMap<string, ReadonlyFactory<Animal>> = new Map([["dogs", dogs]]);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-local-producer-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening when nested under a local proven-covariant wrapper.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[variance(T: out)]
interface Producer<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Producer<ReadonlyHandler<Dog>>;
const animals: Producer<ReadonlyHandler<Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-local-producer-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening at local proven-covariant call sites.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[variance(T: out)]
interface Producer<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Producer<ReadonlyHandler<Dog>>;

function takeAnimal(value: Producer<ReadonlyHandler<Animal>>): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-local-producer-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching when nested under a local proven-covariant wrapper.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[variance(T: out)]
interface Producer<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Producer<ReadonlyFactory<Dog>>;
const animals: Producer<ReadonlyFactory<Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-local-producer-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching at local proven-covariant call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[variance(T: out)]
interface Producer<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Producer<ReadonlyFactory<Dog>>;

function takeAnimal(value: Producer<ReadonlyFactory<Animal>>): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-local-sink-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// narrowing when nested under a local proven-contravariant wrapper.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[variance(T: in)]
interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<ReadonlyHandler<Animal>>;
const dogSink: Sink<ReadonlyHandler<Dog>> = animalSink;
void dogSink;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-local-sink-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// narrowing at local proven-contravariant call sites.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[variance(T: in)]
interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<ReadonlyHandler<Animal>>;

function takeDogSink(value: Sink<ReadonlyHandler<Dog>>): void {
  void value;
}

takeDogSink(animalSink);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-local-sink-assignment.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching when nested under a local proven-contravariant wrapper.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[variance(T: in)]
interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<ReadonlyFactory<Animal>>;
const dogSink: Sink<ReadonlyFactory<Dog>> = animalSink;
void dogSink;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-local-sink-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching at local proven-contravariant call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

// #[variance(T: in)]
interface Sink<T> {
  put(value: T): void;
}

// #[extern]
declare const animalSink: Sink<ReadonlyFactory<Animal>>;

function takeDogSink(value: Sink<ReadonlyFactory<Dog>>): void {
  void value;
}

takeDogSink(animalSink);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-annotated-contract.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1032 "Variance annotation does not match the declaration's proven variance."
//
// Imported utility aliases built from Readonly must still check overclaimed
// variance contracts instead of trusting the outer alias name.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

// #[variance(T: out)]
export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-explicit-generic-method-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through explicit generic method calls.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

class Identity {
  run<T>(value: T): T {
    return value;
  }
}

const identity = new Identity();
const animals = identity.run<ReadonlyHandler<Animal>>(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-explicit-generic-overload-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through explicit generic overload calls.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function id<T>(value: T): T;
function id(value: unknown): unknown {
  return value;
}

const animals = id<ReadonlyHandler<Animal>>(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-explicit-generic-constructor-call.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through explicit generic constructor calls too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

class Holder<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}

const animals = new Holder<ReadonlyFactory<Animal>>(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-function-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through function parameter types.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

const acceptDogs = (value: ReadonlyHandler<Dog>): void => {
  void value;
};

const acceptAnimals: (value: ReadonlyHandler<Animal>) => void = acceptDogs;
void acceptAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-function-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through function return types too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

const makeDogs = (): ReadonlyFactory<Dog> => dogs;
const makeAnimals: () => ReadonlyFactory<Animal> = makeDogs;
void makeAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-imported-set-accessor-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through imported set-accessor interfaces.
//
// #[interop]
import type { AnimalHandlerSink, DogHandlerSink } from "./lib";

// #[extern]
declare const dogs: DogHandlerSink;

const animals: AnimalHandlerSink = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;

export interface DogHandlerSink {
  set value(next: ReadonlyHandler<Dog>);
}

export interface AnimalHandlerSink {
  set value(next: ReadonlyHandler<Animal>);
}
`,
    },
  ),
  fixture(
    'imported-readonly-utility-imported-set-accessor-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through ordinary call sites that use imported set-accessor
// interfaces.
//
// #[interop]
import type { AnimalHandlerSink, DogHandlerSink } from "./lib";

// #[extern]
declare const dogs: DogHandlerSink;

function takeAnimal(value: AnimalHandlerSink): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;

export interface DogHandlerSink {
  set value(next: ReadonlyHandler<Dog>);
}

export interface AnimalHandlerSink {
  set value(next: ReadonlyHandler<Animal>);
}
`,
    },
  ),
  fixture(
    'imported-readonly-utility-method-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through method parameter types too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

const handlers = {
  acceptDogs(value: ReadonlyHandler<Dog>): void {
    void value;
  },
};

const widened: { acceptDogs(value: ReadonlyHandler<Animal>): void } = handlers;
void widened;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-method-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through method return types too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

const makers = {
  makeDogs(): ReadonlyFactory<Dog> {
    return dogs;
  },
};

const widened: { makeDogs(): ReadonlyFactory<Animal> } = makers;
void widened;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through intersection wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> & {} = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-reversed-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening when the alias appears on the right side of an intersection.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: {} & ReadonlyHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-intersection-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening at call sites through intersection wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function takeAnimals(value: ReadonlyHandler<Animal> & {}): void {
  void value;
}

takeAnimals(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through intersection wrappers too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: ReadonlyFactory<Animal> & {} = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-reversed-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching when the alias appears on the right side of an intersection.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: {} & ReadonlyFactory<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-intersection-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through intersection-wrapped function returns too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

const makeDogs = (): ReadonlyFactory<Dog> => dogs;
const makeAnimals: () => (ReadonlyFactory<Animal> & {}) = makeDogs;
void makeAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-conditional-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw conditional type syntax.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: (true extends true ? ReadonlyHandler<Animal> : never) = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-indexed-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw indexed-access type syntax.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ({ current: ReadonlyHandler<Animal> })["current"] = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-indexed-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw mapped-plus-indexed type syntax.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ({ [K in "current"]: ReadonlyHandler<Animal> })["current"] = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-raw-conditional-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through raw conditional return syntax too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

const makeDogs = (): ReadonlyFactory<Dog> => dogs;
const makeAnimals: () => (true extends true ? ReadonlyFactory<Animal> : never) = makeDogs;
void makeAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-raw-indexed-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through raw indexed-access return syntax too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

const makeDogs = (): ReadonlyFactory<Dog> => dogs;
const makeAnimals: () => ({ current: ReadonlyFactory<Animal> })["current"] = makeDogs;
void makeAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-object-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw mapped object types.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: { [K in "current"]: ReadonlyHandler<Animal> } = { current: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-object-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening at raw mapped object call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function takeAnimals(value: { [K in "current"]: ReadonlyHandler<Animal> }): void {
  void value;
}

takeAnimals({ current: dogs });
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-object-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw mapped object returns too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function wrapDogs(): { current: ReadonlyHandler<Dog> } {
  return { current: dogs };
}

const wrapAnimals: () => { [K in "current"]: ReadonlyHandler<Animal> } = wrapDogs;
void wrapAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-object-union-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening when raw mapped object keys are a union.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: { [K in "current" | "backup"]: ReadonlyHandler<Animal> } = { current: dogs, backup: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-raw-mapped-object-readonly-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through readonly raw mapped object properties.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: { readonly [K in "current"]: ReadonlyHandler<Animal> } = { current: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-union-indexed-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through union-key indexed-access wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ({ current: ReadonlyHandler<Animal>; backup: ReadonlyHandler<Animal> })["current" | "backup"] = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-record-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through Record wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: Record<"current", ReadonlyHandler<Animal>> = { current: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-readonly-record-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through Readonly<Record<...>> wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: Readonly<Record<"current", ReadonlyHandler<Animal>>> = { current: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-pick-record-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through Pick<Record<...>> wrappers.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: Pick<Record<"current", ReadonlyHandler<Animal>>, "current"> = { current: dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-index-signature-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through raw index signatures.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: { [key: string]: ReadonlyHandler<Animal> } = { dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-index-signature-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening at raw index-signature call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;

function takeAnimals(value: { [key: string]: ReadonlyHandler<Animal> }): void {
  void value;
}

takeAnimals({ dogs });
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-index-signature-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through raw index signatures too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;
const animals: { [key: string]: ReadonlyFactory<Animal> } = { dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-index-signature-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching at raw index-signature call sites too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

function takeAnimals(value: { [key: string]: ReadonlyFactory<Animal> }): void {
  void value;
}

takeAnimals({ dogs });
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-index-signature-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through raw index-signature returns too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: ReadonlyFactory<Dog>;

function wrapDogs(): { dogs: ReadonlyFactory<Dog> } {
  return { dogs };
}

const wrapAnimals: () => { [key: string]: ReadonlyFactory<Animal> } = wrapDogs;
void wrapAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-typed-index-signature-source.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening between typed raw index signatures, not just object literals.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";
//
// #[extern]
declare const dogs: { [key: string]: ReadonlyHandler<Dog> };
const animals: { [key: string]: ReadonlyHandler<Animal> } = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-typed-index-signature-source.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching between typed raw index signatures too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";
//
// #[extern]
declare const dogs: { [key: string]: ReadonlyFactory<Dog> };
const animals: { [key: string]: ReadonlyFactory<Animal> } = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening when referenced through inline import() types.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyHandler<import("./lib").Dog>;
const animals: import("./lib").ReadonlyHandler<import("./lib").Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening at inline import() call sites too.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyHandler<import("./lib").Dog>;

function takeAnimals(value: import("./lib").ReadonlyHandler<import("./lib").Animal>): void {
  void value;
}

takeAnimals(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-inline-import-type-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through inline import() types too.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyFactory<import("./lib").Dog>;
const animals: import("./lib").ReadonlyFactory<import("./lib").Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-inline-import-type-return-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through inline import() return sites too.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyFactory<import("./lib").Dog>;

const makeDogs = (): import("./lib").ReadonlyFactory<import("./lib").Dog> => dogs;
const makeAnimals: () => import("./lib").ReadonlyFactory<import("./lib").Animal> = makeDogs;
void makeAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-promise-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through Promise wrappers around inline import() types.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyHandler<import("./lib").Dog>;
const animals: Promise<import("./lib").ReadonlyHandler<import("./lib").Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-readonly-array-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through readonly arrays around inline import() types.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyHandler<import("./lib").Dog>;
const animals: readonly import("./lib").ReadonlyHandler<import("./lib").Animal>[] = [dogs];
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-function-parameter-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through function parameter types around inline import() aliases.
//
// const acceptDogs = (value: import("./lib").ReadonlyHandler<import("./lib").Dog>): void => {
//   void value;
// };
const acceptDogs = (value: import("./lib").ReadonlyHandler<import("./lib").Dog>): void => {
  void value;
};
const acceptAnimals: (value: import("./lib").ReadonlyHandler<import("./lib").Animal>) => void = acceptDogs;
void acceptAnimals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-set-accessor-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Inline import-type forms should preserve the same imported set-accessor
// variance checks.
//
// #[extern]
declare const dogs: import("./lib").DogHandlerSink;

const animals: import("./lib").AnimalHandlerSink = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;

export interface DogHandlerSink {
  set value(next: ReadonlyHandler<Dog>);
}

export interface AnimalHandlerSink {
  set value(next: ReadonlyHandler<Animal>);
}
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-set-accessor-call-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Inline import-type forms should still reject unsound widening through call
// sites that use imported set-accessor interfaces.
//
// #[extern]
declare const dogs: import("./lib").DogHandlerSink;

function takeAnimal(value: import("./lib").AnimalHandlerSink): void {
  void value;
}

takeAnimal(dogs);
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;

export interface DogHandlerSink {
  set value(next: ReadonlyHandler<Dog>);
}

export interface AnimalHandlerSink {
  set value(next: ReadonlyHandler<Animal>);
}
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through intersections around inline import() aliases.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyHandler<import("./lib").Dog>;
const animals: import("./lib").ReadonlyHandler<import("./lib").Animal> & {} = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-local-producer-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening under local proven-covariant wrappers when referenced via inline import() types.
//
// #[variance(T: out)]
interface Producer<T> {
  readonly value: T;
}

// #[extern]
declare const dogs: Producer<import("./lib").ReadonlyHandler<import("./lib").Dog>>;
const animals: Producer<import("./lib").ReadonlyHandler<import("./lib").Animal>> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-inline-import-type-promise-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through Promise wrappers around inline import() types.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyFactory<import("./lib").Dog>;
const animals: Promise<import("./lib").ReadonlyFactory<import("./lib").Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-inline-import-type-intersection-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through intersections around inline import() types too.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyFactory<import("./lib").Dog>;
const animals: import("./lib").ReadonlyFactory<import("./lib").Animal> & {} = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-factory-inline-import-type-index-signature-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through raw index signatures around inline import() types too.
//
// #[extern]
declare const dogs: import("./lib").ReadonlyFactory<import("./lib").Dog>;
const animals: { [key: string]: import("./lib").ReadonlyFactory<import("./lib").Animal> } = { dogs };
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-type-predicate-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through type predicate signatures.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./lib";

const isDog = ((value: unknown): value is ReadonlyHandler<Dog> => true);
const isAnimal: (value: unknown) => value is ReadonlyHandler<Animal> = isDog;
void isAnimal;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-type-predicate-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should still reject unsound
// widening through type predicate signatures over inline import() types.
//
const isDog = ((value: unknown): value is import("./lib").ReadonlyHandler<import("./lib").Dog> => true);
const isAnimal: (value: unknown) => value is import("./lib").ReadonlyHandler<import("./lib").Animal> = isDog;
void isAnimal;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-assertion-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through assertion signatures too.
//
// #[interop]
import type { Animal, Dog, ReadonlyFactory } from "./lib";

const assertDog: (value: unknown) => asserts value is ReadonlyFactory<Dog> = (_value) => {};
const assertAnimal: (value: unknown) => asserts value is ReadonlyFactory<Animal> = assertDog;
void assertAnimal;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-inline-import-assertion-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from Readonly should preserve generic class
// exact matching through assertion signatures over inline import() types too.
//
const assertDog: (value: unknown) => asserts value is import("./lib").ReadonlyFactory<import("./lib").Dog> = (_value) => {};
const assertAnimal: (value: unknown) => asserts value is import("./lib").ReadonlyFactory<import("./lib").Animal> = assertDog;
void assertAnimal;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export declare class Box<T> {
  readonly value: T;
}

export interface Factory<T> {
  create(): Box<T>;
}

export type ReadonlyFactory<T> = Readonly<Factory<T>>;
`,
    },
  ),
  fixture(
    'imported-readonly-utility-barrel-reexport-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Named imported utility aliases should keep their generic identity through
// barrel re-export chains too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "./barrel";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> = dogs;
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
      'src/barrel.d.ts': `export type { Animal, Dog, ReadonlyHandler } from "./lib";
`,
    },
  ),
  fixture(
    'imported-readonly-utility-package-root-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Named imported utility aliases should keep their generic identity through
// package-root type resolution too.
//
// #[interop]
import type { Animal, Dog, ReadonlyHandler } from "pkg";
//
// #[extern]
declare const dogs: ReadonlyHandler<Dog>;
const animals: ReadonlyHandler<Animal> = dogs;
void animals;
`,
    {
      'tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"]
}
`,
      'node_modules/pkg/package.json': `{
  "name": "pkg",
  "type": "module",
  "exports": {
    ".": {
      "types": "./index.d.ts"
    }
  },
  "types": "./index.d.ts"
}
`,
      'node_modules/pkg/index.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type ReadonlyHandler<T> = Readonly<Handler<T>>;
`,
    },
  ),
  fixture(
    'imported-pick-utility-promise-site.reject.ts',
    `// @sound-test: reject
// @sound-error: SOUND1019
//
// Imported utility aliases built from other mapped utilities should also stay
// invariant through wrapper sites.
//
// #[interop]
import type { Animal, Dog, PickedHandler } from "./lib";
//
// #[extern]
declare const dogs: PickedHandler<Dog>;
const animals: Promise<PickedHandler<Animal>> = Promise.resolve(dogs);
void animals;
`,
    {
      'src/lib.d.ts': `export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  breed: string;
}

export interface Handler<T> {
  use(value: T): void;
}

export type PickedHandler<T> = Pick<Handler<T>, "use">;
`,
    },
  ),
] as const;
