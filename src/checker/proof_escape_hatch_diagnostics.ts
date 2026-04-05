import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from './engine/diagnostic_codes.ts';
import type { AnalysisContext } from './engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from './diagnostics.ts';

const ANY_TYPE_EXAMPLE =
  'Replace `any` with `unknown`, then narrow or validate before use, or spell the precise type you expect.';
const TYPE_ASSERTION_EXAMPLE =
  'Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.';
const NON_NULL_ASSERTION_EXAMPLE =
  'Check the value first, or normalize it with a real fallback before using it as present.';
const DEFINITE_ASSIGNMENT_ASSERTION_EXAMPLE =
  'Initialize the declaration directly, widen it to include `undefined`, or move the unchecked assumption to a local `// #[unsafe] let x!: T` site that the backend can still represent honestly.';

function createDiagnostic(
  node: ts.Node,
  code:
    | typeof SOUND_DIAGNOSTIC_CODES.anyType
    | typeof SOUND_DIAGNOSTIC_CODES.definiteAssignmentAssertion
    | typeof SOUND_DIAGNOSTIC_CODES.nonNullAssertion
    | typeof SOUND_DIAGNOSTIC_CODES.typeAssertion,
  message: string,
  options?: {
    hint?: string;
    metadata?: SoundDiagnostic['metadata'];
    notes?: string[];
  },
): SoundDiagnostic {
  return {
    source: 'sound',
    code,
    category: 'error',
    message,
    metadata: options?.metadata,
    notes: options?.notes,
    hint: options?.hint,
    ...getNodeDiagnosticRange(node),
  };
}

export function createAnyTypeDiagnostic(node: ts.Node): SoundDiagnostic {
  return createDiagnostic(
    node,
    SOUND_DIAGNOSTIC_CODES.anyType,
    SOUND_DIAGNOSTIC_MESSAGES.anyType,
    {
      metadata: {
        rule: 'any_type',
        fixability: 'local_rewrite',
        invariant:
          'Checked soundscript code must preserve honest type information instead of erasing it to `any`.',
        replacementFamily: 'unknown_plus_validation',
        counterexample:
          'Using `any` lets unchecked assumptions flow outward and disables the proof obligations soundscript relies on.',
        example: ANY_TYPE_EXAMPLE,
      },
      notes: [
        '`any` erases the type information that checked soundscript code relies on.',
        `Example: ${ANY_TYPE_EXAMPLE}`,
      ],
      hint:
        'Replace `any` with `unknown` plus validation, or write the precise type directly.',
    },
  );
}

export function createTypeAssertionDiagnostic(
  context: AnalysisContext,
  node: ts.TypeAssertion | ts.AsExpression,
): SoundDiagnostic {
  const expressionType = context.checker.typeToString(context.checker.getTypeAtLocation(node.expression));
  const assertedType = context.checker.typeToString(context.checker.getTypeFromTypeNode(node.type));

  return createDiagnostic(
    node,
    SOUND_DIAGNOSTIC_CODES.typeAssertion,
    SOUND_DIAGNOSTIC_MESSAGES.typeAssertion,
    {
      metadata: {
        rule: 'unchecked_type_assertion',
        fixability: 'local_rewrite',
        invariant:
          'Checked soundscript code must prove the target type instead of asserting it without evidence.',
        replacementFamily: 'control_flow_narrowing_or_boundary_validation',
        evidence: [
          { label: 'expressionType', value: expressionType },
          { label: 'assertedType', value: assertedType },
        ],
        counterexample:
          'A type assertion can claim a value has structure or variants that the checker never proved.',
        example: TYPE_ASSERTION_EXAMPLE,
      },
      notes: [
        `This assertion changes the type from '${expressionType}' to '${assertedType}' without a checked proof.`,
        `Example: ${TYPE_ASSERTION_EXAMPLE}`,
      ],
      hint:
        'Use narrowing, validation, or an interop boundary instead of asserting the target type.',
    },
  );
}

export function createNonNullAssertionDiagnostic(
  context: AnalysisContext,
  node: ts.NonNullExpression,
): SoundDiagnostic {
  const expressionType = context.checker.typeToString(context.checker.getTypeAtLocation(node.expression));

  return createDiagnostic(
    node,
    SOUND_DIAGNOSTIC_CODES.nonNullAssertion,
    SOUND_DIAGNOSTIC_MESSAGES.nonNullAssertion,
    {
      metadata: {
        rule: 'unchecked_non_null_assertion',
        fixability: 'local_rewrite',
        invariant:
          'Checked soundscript code must prove that maybe-null values are present before using them as non-null.',
        replacementFamily: 'explicit_null_check',
        evidence: [{ label: 'expressionType', value: expressionType }],
        counterexample:
          'A non-null assertion can pretend a maybe-null value is present even though another path still allows `null` or `undefined`.',
        example: NON_NULL_ASSERTION_EXAMPLE,
      },
      notes: [
        `This expression has type '${expressionType}', but \`!\` skips the proof that it is present.`,
        `Example: ${NON_NULL_ASSERTION_EXAMPLE}`,
      ],
      hint:
        'Re-check the value or provide an explicit fallback before using it as non-null.',
    },
  );
}

export function createDefiniteAssignmentAssertionDiagnostic(
  context: AnalysisContext,
  node: ts.VariableDeclaration | ts.PropertyDeclaration,
): SoundDiagnostic {
  const typeText = node.type
    ? context.checker.typeToString(context.checker.getTypeFromTypeNode(node.type))
    : context.checker.typeToString(context.checker.getTypeAtLocation(node.name));
  const targetText = ts.isIdentifier(node.name) ? node.name.text : node.name.getText();
  const diagnosticNode = node.exclamationToken ?? node.name;

  return createDiagnostic(
    diagnosticNode,
    SOUND_DIAGNOSTIC_CODES.definiteAssignmentAssertion,
    SOUND_DIAGNOSTIC_MESSAGES.definiteAssignmentAssertion,
    {
      metadata: {
        rule: 'unchecked_definite_assignment_assertion',
        fixability: 'local_rewrite',
        invariant:
          'Checked soundscript code must not claim that storage is initialized before the checker can prove that write happened.',
        replacementFamily: 'initializer_or_explicit_optional_state',
        evidence: [
          { label: 'target', value: targetText },
          { label: 'assertedType', value: typeText },
        ],
        counterexample:
          'A definite-assignment assertion can let code read an uninitialized local or field as if the promised value already existed.',
        example: DEFINITE_ASSIGNMENT_ASSERTION_EXAMPLE,
      },
      notes: [
        `This declaration claims '${targetText}' is definitely assigned as '${typeText}' without a checked proof.`,
        `Example: ${DEFINITE_ASSIGNMENT_ASSERTION_EXAMPLE}`,
      ],
      hint:
        'Add an initializer, widen the type to include absence, or move the unchecked claim to a supported local unsafe site.',
    },
  );
}
