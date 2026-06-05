import { Project, SyntaxKind, Node } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "tsconfig.typecheck-core.json",
});

function makeFunctionAsync(funcNode) {
  if (!funcNode) return;
  if (!funcNode.isAsync()) {
    funcNode.setIsAsync(true);
    
    // Update return type
    const returnTypeNode = funcNode.getReturnTypeNode();
    if (returnTypeNode) {
      const currentType = returnTypeNode.getText();
      if (!currentType.startsWith("Promise<")) {
        funcNode.setReturnType(`Promise<${currentType}>`);
      }
    }
  }
}

function processCall(callExpr) {
  const parent = callExpr.getParent();
  
  if (Node.isAwaitExpression(parent)) {
    return false; // Already awaited
  }

  if (Node.isReturnStatement(parent) || Node.isArrowFunction(parent)) {
    // If returning a promise, the function just needs to be async
    const funcNode = callExpr.getFirstAncestor(n => 
      Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isMethodDeclaration(n) || Node.isFunctionExpression(n)
    );
    if (funcNode && !funcNode.isAsync()) {
      makeFunctionAsync(funcNode);
      return true;
    }
    return false;
  }

  // We need to add await
  callExpr.replaceWithText(`await ${callExpr.getText()}`);
  
  const funcNode = callExpr.getFirstAncestor(n => 
    Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isMethodDeclaration(n) || Node.isFunctionExpression(n)
  );
  if (funcNode) {
    makeFunctionAsync(funcNode);
  }
  return true;
}

let passes = 0;
while (passes < 15) {
  let madeChanges = false;
  const files = project.getSourceFiles();

  for (const file of files) {
    if (!file.getFilePath().includes("/src/lib/db/") && !file.getFilePath().includes("/src/lib/usage/") && !file.getFilePath().includes("/src/lib/modelsDevSync.ts") && !file.getFilePath().includes("/open-sse/")) {
      continue;
    }

    const callExpressions = file.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const callExpr of callExpressions) {
      try {
        const expr = callExpr.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const propName = expr.getName();
          if (["all", "get", "run", "transaction"].includes(propName)) {
            const callerText = expr.getExpression().getText();
            if (callerText.includes("prepare(") || (propName === "transaction" && callerText.includes("db."))) {
              if (processCall(callExpr)) {
                madeChanges = true;
                break; // Restart loop to avoid detached node errors
              }
            }
          }
          
          // Also handle `.map()`, `.find()`, `.filter()`, `.length` on promises
          // We can check if the expression type is a Promise, but ts-morph type checker is slow.
          // Let's rely on standard async propagation: if the function returns a Promise, callers must await.
        }

        // Propagate async to callers
        if (Node.isIdentifier(expr)) {
          const type = expr.getType();
          const signatures = type.getCallSignatures();
          if (signatures.length > 0) {
            const returnType = signatures[0].getReturnType().getText();
            if (returnType.includes("Promise<")) {
              if (processCall(callExpr)) {
                madeChanges = true;
                break;
              }
            }
          }
        }
      } catch (e) {
        // Ignored
      }
    }
  }

  if (!madeChanges) break;
  project.saveSync();
  console.log(`Pass ${passes + 1} complete.`);
  passes++;
}

console.log("Done refactoring async calls.");