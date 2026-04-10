import ts from 'typescript';

import { type AnnotationLookup, createAnnotationLookup } from '../../language/annotation_syntax.ts';
import { normalizeRuntimeContext } from '../../project/config.ts';
import { isForeignSourceFile } from '../../project/soundscript_packages.ts';
import { createAnalysisFactStore } from './facts.ts';
import type {
  AnalysisContext,
  CreateAnalysisContextOptions,
  ExportSummary,
  PredicateVerificationTargetFact,
} from './types.ts';

function isNode(subject: ts.Node | ts.Symbol): subject is ts.Node {
  return 'kind' in subject;
}

function traverseNode(
  node: ts.Node,
  visitor: (node: ts.Node) => void,
  isGeneratedNode: (node: ts.Node) => boolean,
): void {
  if (!ts.isSourceFile(node) && isGeneratedNode(node)) {
    return;
  }

  visitor(node);
  ts.forEachChild(node, (child) => traverseNode(child, visitor, isGeneratedNode));
}

export function createAnalysisContext(options: CreateAnalysisContextOptions): AnalysisContext {
  const checker = options.program.getTypeChecker();
  const factStore = createAnalysisFactStore();
  const nodeIds = new WeakMap<ts.Node, number>();
  const symbolIds = new WeakMap<ts.Symbol, number>();
  const exportSummariesBySymbolId = new Map<number, ExportSummary>();
  const annotationLookups = new WeakMap<ts.SourceFile, AnnotationLookup>();
  const generatedNodeCache = new WeakMap<ts.Node, boolean>();
  const sourceFiles = options.program.getSourceFiles().filter(
    (sourceFile: ts.SourceFile) =>
      !options.program.isSourceFileDefaultLibrary(sourceFile) &&
      (
        !options.program.isSourceFileFromExternalLibrary(sourceFile) ||
        !isForeignSourceFile(sourceFile.fileName, ts.sys)
      ) &&
      (options.includeSourceFile?.(sourceFile) ?? true),
  );
  const runtime = options.runtime ?? normalizeRuntimeContext({
    target: 'js-node',
  });
  let nextNodeId = 1;
  let nextSymbolId = 1;

  function getSubjectCacheKey(subject: ts.Node | ts.Symbol): string {
    if (isNode(subject)) {
      return `node:${context.getNodeId(subject)}`;
    }

    return `symbol:${context.getSymbolId(subject)}`;
  }

  function getCanonicalExportSummarySymbol(symbol: ts.Symbol): ts.Symbol {
    let currentSymbol = symbol;
    const visitedSymbols = new Set<ts.Symbol>();

    while (!visitedSymbols.has(currentSymbol)) {
      visitedSymbols.add(currentSymbol);

      if (currentSymbol.flags & ts.SymbolFlags.Alias) {
        const aliasedSymbol = checker.getAliasedSymbol(currentSymbol);
        if (aliasedSymbol && aliasedSymbol !== currentSymbol) {
          currentSymbol = aliasedSymbol;
          continue;
        }
      }

      const exportedSymbol = checker.getExportSymbolOfSymbol(currentSymbol);
      if (exportedSymbol !== currentSymbol) {
        currentSymbol = exportedSymbol;
        continue;
      }

      return currentSymbol;
    }

    return currentSymbol;
  }

  const context: AnalysisContext = {
    checker,
    exportSummaries: {
      canonicalizeSymbol(symbol: ts.Symbol): ts.Symbol {
        return getCanonicalExportSummarySymbol(symbol);
      },
      get(symbol: ts.Symbol): ExportSummary | undefined {
        return exportSummariesBySymbolId.get(
          context.getSymbolId(getCanonicalExportSummarySymbol(symbol)),
        );
      },
      set(symbol: ts.Symbol, summary: ExportSummary): ExportSummary {
        exportSummariesBySymbolId.set(
          context.getSymbolId(getCanonicalExportSummarySymbol(symbol)),
          summary,
        );
        return summary;
      },
    },
    facts: {
      getAliasRelationship(source: ts.Node | ts.Symbol, target: ts.Node | ts.Symbol, compute) {
        return factStore.getOrCompute(
          'alias',
          `${getSubjectCacheKey(source)}->${getSubjectCacheKey(target)}`,
          compute,
        );
      },
      peekEffectSummary(node: ts.Node) {
        return factStore.get(
          'effectSummary',
          `node:${context.getNodeId(node)}`,
        ) as import('./types.ts').EffectSummaryFact | undefined;
      },
      getEffectSummary(node: ts.Node, compute) {
        return factStore.getOrCompute('effectSummary', `node:${context.getNodeId(node)}`, compute);
      },
      setEffectSummary(node: ts.Node, fact) {
        factStore.set('effectSummary', `node:${context.getNodeId(node)}`, fact);
        return fact;
      },
      getFlowBranchStructure(node: ts.Statement, compute) {
        return factStore.getOrCompute(
          'flowBranchStructure',
          `node:${context.getNodeId(node)}`,
          compute,
        );
      },
      getFlowChildRegionStructure(node: ts.Statement, compute) {
        return factStore.getOrCompute(
          'flowChildRegionStructure',
          `node:${context.getNodeId(node)}`,
          compute,
        );
      },
      getFlowConditionStructure(node: ts.Expression, compute) {
        return factStore.getOrCompute(
          'flowConditionStructure',
          `node:${context.getNodeId(node)}`,
          compute,
        );
      },
      getFlowInvalidationStructure(node: ts.Node, optionsKey: string, compute) {
        return factStore.getOrCompute(
          'flowInvalidationStructure',
          `node:${context.getNodeId(node)}|options:${optionsKey}`,
          compute,
        );
      },
      getFlowStatementStructure(node: ts.Statement, compute) {
        return factStore.getOrCompute(
          'flowStatementStructure',
          `node:${context.getNodeId(node)}`,
          compute,
        );
      },
      getFlowRegionStructure(node: ts.Node, optionsKey: string, compute) {
        return factStore.getOrCompute(
          'flowRegionStructure',
          `node:${context.getNodeId(node)}|options:${optionsKey}`,
          compute,
        );
      },
      getForeignProjection(symbol: ts.Symbol, compute) {
        return factStore.getOrCompute(
          'foreignProjection',
          `symbol:${context.getSymbolId(symbol)}`,
          compute,
        );
      },
      getMutability(subject: ts.Node | ts.Symbol, compute) {
        return factStore.getOrCompute('mutability', getSubjectCacheKey(subject), compute);
      },
      getNamespaceResolver(node: ts.Node, compute) {
        const key = `node:${context.getNodeId(node)}`;
        const cached = factStore.get('namespaceResolver', key) as
          | import('./types.ts').NamespaceResolverFact
          | undefined;
        if (cached) {
          return cached;
        }

        const created = compute();
        if (created) {
          factStore.set('namespaceResolver', key, created);
        }

        return created;
      },
      getNamespaceShape(node: ts.Node, compute) {
        const key = `node:${context.getNodeId(node)}`;
        const cached = factStore.get('namespaceShape', key) as
          | import('./types.ts').NamespaceShapeFact
          | undefined;
        if (cached) {
          return cached;
        }

        const created = compute();
        if (created) {
          factStore.set('namespaceShape', key, created);
        }

        return created;
      },
      getNamespaceResolverSymbol(symbol: ts.Symbol) {
        return factStore.get(
          'namespaceResolver',
          `symbol:${context.getSymbolId(symbol)}`,
        ) as import('./types.ts').NamespaceResolverFact | undefined;
      },
      getNamespaceShapeSymbol(symbol: ts.Symbol) {
        return factStore.get(
          'namespaceShape',
          `symbol:${context.getSymbolId(symbol)}`,
        ) as import('./types.ts').NamespaceShapeFact | undefined;
      },
      getNarrowing(node: ts.Node, symbol: ts.Symbol, compute) {
        return factStore.getOrCompute(
          'narrowing',
          `node:${context.getNodeId(node)}|symbol:${context.getSymbolId(symbol)}`,
          compute,
        );
      },
      getNonOrdinaryRecovery(node: ts.Node, family, compute) {
        return factStore.getOrCompute(
          'nonOrdinaryRecovery',
          `node:${context.getNodeId(node)}|family:${family}`,
          compute,
        );
      },
      getPredicateVerificationTarget(node: ts.Node, compute) {
        const key = `node:${context.getNodeId(node)}`;
        const cached = factStore.get<PredicateVerificationTargetFact>(
          'predicateVerificationTarget',
          key,
        );
        if (cached) {
          return cached;
        }

        const created = compute();
        if (created) {
          factStore.set('predicateVerificationTarget', key, created);
        }

        return created;
      },
      getUnsafeValueOrigin(symbol: ts.Symbol) {
        return factStore.get(
          'unsafeValueOrigin',
          `symbol:${context.getSymbolId(symbol)}`,
        );
      },
      setForeignProjection(symbol: ts.Symbol, fact) {
        factStore.set('foreignProjection', `symbol:${context.getSymbolId(symbol)}`, fact);
        return fact;
      },
      setNamespaceResolverSymbol(symbol: ts.Symbol, fact) {
        factStore.set('namespaceResolver', `symbol:${context.getSymbolId(symbol)}`, fact);
        return fact;
      },
      setNamespaceShapeSymbol(symbol: ts.Symbol, fact) {
        factStore.set('namespaceShape', `symbol:${context.getSymbolId(symbol)}`, fact);
        return fact;
      },
      setSymbolProvenance(symbol: ts.Symbol, fact) {
        factStore.set('symbolProvenance', `symbol:${context.getSymbolId(symbol)}`, fact);
        return fact;
      },
      setUnsafeValueOrigin(symbol: ts.Symbol, fact) {
        factStore.set('unsafeValueOrigin', `symbol:${context.getSymbolId(symbol)}`, fact);
        return fact;
      },
      getSymbolProvenance(symbol: ts.Symbol, compute) {
        return factStore.getOrCompute(
          'symbolProvenance',
          `symbol:${context.getSymbolId(symbol)}`,
          compute,
        );
      },
    },
    isGeneratedNode(node: ts.Node): boolean {
      const cached = generatedNodeCache.get(node);
      if (cached !== undefined) {
        return cached;
      }

      const generated = options.isGeneratedNode?.(node) ?? false;
      generatedNodeCache.set(node, generated);
      return generated;
    },
    program: options.program,
    runtime,
    workingDirectory: options.workingDirectory,
    forEachSourceFile(visitor: (sourceFile: ts.SourceFile) => void): void {
      for (const sourceFile of sourceFiles) {
        visitor(sourceFile);
      }
    },
    getAnnotationLookup(sourceFile: ts.SourceFile): AnnotationLookup {
      const cachedLookup = annotationLookups.get(sourceFile);
      if (cachedLookup) {
        return cachedLookup;
      }

      const createdLookup = createAnnotationLookup(sourceFile);
      annotationLookups.set(sourceFile, createdLookup);
      return createdLookup;
    },
    getNodeId(node: ts.Node): number {
      const cachedId = nodeIds.get(node);
      if (cachedId !== undefined) {
        return cachedId;
      }

      const createdId = nextNodeId;
      nextNodeId += 1;
      nodeIds.set(node, createdId);
      return createdId;
    },
    getSourceFiles(): readonly ts.SourceFile[] {
      return sourceFiles;
    },
    getSymbolId(symbol: ts.Symbol): number {
      const cachedId = symbolIds.get(symbol);
      if (cachedId !== undefined) {
        return cachedId;
      }

      const createdId = nextSymbolId;
      nextSymbolId += 1;
      symbolIds.set(symbol, createdId);
      return createdId;
    },
    traverse(node: ts.Node, visitor: (currentNode: ts.Node) => void): void {
      traverseNode(node, visitor, context.isGeneratedNode);
    },
  };

  return context;
}
