/**
 * Audits source-level API documentation using the TypeScript compiler API.
 *
 * This intentionally checks internal named helpers as well as exported APIs:
 * internal contracts are where dialect and driver behavior is easiest to lose.
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const roots = ["packages/thor/src", "packages/cli/src"]
const errors = []

const sourceFiles = roots.flatMap((root) => {
  const visit = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) return visit(target)
      return entry.isFile() && target.endsWith(".ts") ? [target] : []
    })
  return visit(root)
})

const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
const hasJSDoc = (node) => ts.getJSDocCommentsAndTags(node).some((doc) => ts.isJSDoc(doc))
const tagsFor = (node) => ts.getJSDocTags(node)
const tagNames = (node, kind) =>
  tagsFor(node)
    .filter((tag) => tag.kind === kind && "name" in tag && tag.name)
    .map((tag) => tag.name.getText())

const location = (source, node) => {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${source.fileName}:${line + 1}:${character + 1}`
}

const report = (source, node, message) => errors.push(`${location(source, node)} ${message}`)

const callableName = (source, node, fallback) => {
  if ("name" in node && node.name) return node.name.getText(source)
  return fallback
}

const checkCallable = (source, owner, callable, name, options = {}) => {
  if (!hasJSDoc(owner)) {
    report(source, owner, `${name} is missing JSDoc`)
    return
  }

  const documentedParams = new Set(tagNames(owner, ts.SyntaxKind.JSDocParameterTag))
  for (const parameter of callable.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue
    if (!documentedParams.has(parameter.name.text)) {
      report(source, owner, `${name} is missing @param ${parameter.name.text}`)
    }
  }

  if (!options.noReturn && !tagsFor(owner).some((tag) => tag.kind === ts.SyntaxKind.JSDocReturnTag)) {
    report(source, owner, `${name} is missing @returns`)
  }
}

const checkExportedDeclaration = (source, node) => {
  if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return
  if (!hasJSDoc(node)) report(source, node, `${callableName(source, node, "exported declaration")} is missing JSDoc`)
}

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, "utf8")
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  if (!/^(?:#![^\n]*\n)?\/\*\*[\s\S]*?@module\s+[^\s*]+[\s\S]*?\*\//.test(text)) {
    errors.push(`${file}:1:1 source file is missing a top-level @module tag`)
  }

  for (const statement of source.statements) {
    if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      checkExportedDeclaration(source, statement)
    }

    if (ts.isFunctionDeclaration(statement)) {
      checkCallable(source, statement, statement, callableName(source, statement, "function"))
    }

    if (ts.isVariableStatement(statement)) {
      checkExportedDeclaration(source, statement)
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source)
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          checkCallable(source, statement, declaration.initializer, name)
        }
        if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
          for (const property of declaration.initializer.properties) {
            if (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) {
              checkCallable(source, property, property.initializer, `${name}.${property.name.getText(source)}`)
            } else if (ts.isMethodDeclaration(property)) {
              checkCallable(source, property, property, `${name}.${property.name.getText(source)}`)
            }
          }
        }
      }
    }

    if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? "class"
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) {
          checkCallable(source, member, member, `${className}.constructor`, { noReturn: true })
        } else if (ts.isMethodDeclaration(member)) {
          checkCallable(source, member, member, `${className}.${callableName(source, member, "method")}`)
        } else if (ts.isGetAccessorDeclaration(member)) {
          checkCallable(source, member, member, `${className}.${callableName(source, member, "getter")}`)
        } else if (ts.isSetAccessorDeclaration(member)) {
          checkCallable(source, member, member, `${className}.${callableName(source, member, "setter")}`, { noReturn: true })
        }
      }
    }

    if (ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        const memberName = callableName(source, member, "call signature")
        if (ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member)) {
          checkCallable(source, member, member, `${statement.name.text}.${memberName}`)
        } else if (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) {
          checkCallable(source, member, member.type, `${statement.name.text}.${memberName}`)
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Documentation audit failed with ${errors.length} issue(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Documentation audit passed for ${sourceFiles.length} source modules.`)
}
