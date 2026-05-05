import ts from "typescript";

function validateHonestHeapBoundaryNode(node: ts.Node, checker: ts.TypeChecker): void {
  ts.forEachChild(node, (child) => validateHonestHeapBoundaryNode(child, checker));
}

export function validateHonestHeapBoundarySurfaces(program: ts.Program): void {
  const checker = program.getTypeChecker();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    validateHonestHeapBoundaryNode(sourceFile, checker);
  }
}
