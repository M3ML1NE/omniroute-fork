import { Project, SyntaxKind, Node } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "tsconfig.typecheck-core.json",
});

let globalChanges = 0;

function runPass() {
  let madeChanges = false;
  const files = project.getSourceFiles();

  for (const file of files) {
    if (!file.getFilePath().includes("/src/lib/db/") && !file.getFilePath().includes("/src/lib/usage/") && !file.getFilePath().includes("/open-sse/")) {
      continue;
    }

    const callExpressions = file.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const callExpr of callExpressions) {
      try {
        const expr = callExpr.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const propName = expr.getName();
          if (propName === "all" || propName === "get" || propName === "run" || propName === "transaction") {
            const callerText = expr.getExpression().getText();
            if (callerText.includes("prepare(") || (propName === "transaction" && callerText.includes("db."))) {
              const parent = callExpr.getParent();
              if (!Node.isAwaitExpression(parent) && !Node.isReturnStatement(parent) && !Node.isArrowFunction(parent)) {
                callExpr.replaceWithText(`await ${callExpr.getText()}`);
                madeChanges = true;
                globalChanges++;
                break; // Break the loop over callExprs to avoid forgotten nodes
              }
              // If it's returned directly, we still need to make the function async
              const funcNode = callExpr.getFirstAncestor(n => 
                Node.isFunctionDeclaration(n) || 
                Node.isArrowFunction(n) || 
                Node.isMethodDeclaration(n) ||
                Node.isFunctionExpression(n)
              );
              if (funcNode && !funcNode.isAsync()) {
                  funcNode.setIsAsync(true);
                  const returnTypeNode = funcNode.getReturnTypeNode();
                  if (returnTypeNode) {
                    const currentType = returnTypeNode.getText();
                    if (!currentType.startsWith("Promise<")) {
                      funcNode.setReturnType(`Promise<${currentType}>`);
                    }
                  }
                  madeChanges = true;
                  globalChanges++;
                  break;
              }
            }
          }
        }
      } catch (e) {
        // ignore forgotten nodes
      }
    }
  }

  if (madeChanges) {
    project.saveSync();
    console.log("Pass complete, re-running...");
    return true;
  }
  return false;
}

while (runPass()) {}
console.log(`Done! Made ${globalChanges} changes total.`);