import type { AnalysisContext } from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';
import { measureCheckerTiming } from '../timing.ts';

import { runAnnotationValidationRules } from './directive_validation.ts';
import { runFlowRules } from './flow.ts';
import { runNamespaceObjectRules } from './namespace_object.ts';
import { runNullPrototypeRules } from './null_prototype.ts';
import { runOverloadRules } from './overloads.ts';
import { runRelationRules } from './relations.ts';
import { runTypeGuardRules } from './type_guards.ts';
import { runUnsoundImportRules } from './unsound_imports.ts';
import { runUnsoundSyntaxRules } from './unsound_syntax.ts';
import { runValueTypeRules } from './value_types.ts';

function runTimedSoundRule(
  name: string,
  context: AnalysisContext,
  runRule: (context: AnalysisContext) => SoundDiagnostic[],
): SoundDiagnostic[] {
  const metadata: Record<string, number | string> = {
    sourceFiles: context.getSourceFiles().length,
  };
  return measureCheckerTiming(
    `project.analyze.sound.rule.${name}`,
    metadata,
    () => {
      const diagnostics = runRule(context);
      metadata.diagnostics = diagnostics.length;
      return diagnostics;
    },
    { always: true },
  );
}

export function runSoundAnalysis(context: AnalysisContext): SoundDiagnostic[] {
  return [
    ...runTimedSoundRule('directiveValidation', context, runAnnotationValidationRules),
    ...runTimedSoundRule('unsoundSyntax', context, runUnsoundSyntaxRules),
    ...runTimedSoundRule('unsoundImports', context, runUnsoundImportRules),
    ...runTimedSoundRule('namespaceObject', context, runNamespaceObjectRules),
    ...runTimedSoundRule('nullPrototype', context, runNullPrototypeRules),
    ...runTimedSoundRule('relations', context, runRelationRules),
    ...runTimedSoundRule('valueTypes', context, runValueTypeRules),
    ...runTimedSoundRule('flow', context, runFlowRules),
    ...runTimedSoundRule('typeGuards', context, runTypeGuardRules),
    ...runTimedSoundRule('overloads', context, runOverloadRules),
  ];
}
