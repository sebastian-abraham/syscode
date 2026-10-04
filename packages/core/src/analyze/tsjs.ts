/**
 * TypeScript / JavaScript analysis via the TypeScript compiler's parser.
 * No type checking, no project graph beyond what the code actually says —
 * we only need import/export/symbol facts, and those are cheap and exact.
 */
import ts from 'typescript';
import path from 'node:path';
import type { FileFacts, ImportFact, SymbolFact } from '../types.ts';
import { countLoc, hashText, type ScannedFile } from './scan.ts';

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Map of repo-relative lowercased path (without extension) → real path, for import resolution. */
export function buildPathIndex(files: ScannedFile[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of files) {
    if (!f.isSource && f.lang !== 'typescript' && f.lang !== 'javascript') continue;
    const noExt = f.path.replace(/\.[a-z]+$/i, '');
    idx.set(noExt.toLowerCase(), f.path);
    if (/\/index$/.test(noExt)) idx.set(noExt.replace(/\/index$/, '').toLowerCase(), f.path);
  }
  return idx;
}

/** True when the file is source we understand (ts/js variants). */
export function isTsJs(f: ScannedFile): boolean {
  return f.lang === 'typescript' || f.lang === 'javascript';
}

export function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveSpecifier(fromPath: string, specifier: string, index: Map<string, string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const baseDir = path.posix.dirname(fromPath);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
  const candidates = expandedCandidates(joined);
  for (const c of candidates) {
    const hit = index.get(c.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

function expandedCandidates(joined: string): string[] {
  const out: string[] = [];
  const withoutExt = joined.replace(/\.[a-z]+$/i, '');
  out.push(joined, withoutExt);
  for (const ext of RESOLVE_EXTS) out.push(withoutExt + ext, `${withoutExt}/index${ext}`);
  return out;
}

export function analyzeTsJs(file: ScannedFile, index: Map<string, string>): FileFacts {
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: ImportFact[] = [];
  const symbols: SymbolFact[] = [];
  const exports = new Set<string>();

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const pushImports = (spec: string, node: ts.Node) => {
    const pkg = packageOf(spec);
    imports.push({
      specifier: spec,
      resolved: resolveSpecifier(file.path, spec, index),
      external: Boolean(pkg),
      package: pkg,
    });
    void node;
  };

  const collectBindingNames = (name: ts.BindingName | undefined, into: Set<string>) => {
    if (!name) return;
    if (ts.isIdentifier(name)) into.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (ts.isBindingElement(el)) collectBindingNames(el.name, into);
    }
  };

  const visit = (node: ts.Node) => {
    // imports / re-exports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      pushImports(node.moduleSpecifier.text, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      pushImports(node.moduleSpecifier.text, node);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      pushImports(node.arguments[0].text, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      pushImports(node.moduleReference.expression.text, node);
    }

    const exported = hasExportModifier(node);
    if (exported) {
      const names = new Set<string>();
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) collectBindingNames(d.name, names);
      } else if ((node as ts.NamedDeclaration).name && ts.isIdentifier((node as ts.NamedDeclaration).name as ts.Node)) {
        names.add(((node as ts.NamedDeclaration).name as ts.Identifier).text);
      }
      for (const n of names) exports.add(n);
    }

    if (ts.isExportAssignment(node)) {
      // export default ...
      exports.add('default');
    }

    // symbols that mean something structurally
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: 'function', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: 'class', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: 'interface', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: 'type', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && isTopLevelLike(node, sf)) {
      symbols.push({ name: node.name.text, kind: 'method', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
    } else if (ts.isVariableStatement(node) && isArrowOrFunctionInit(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          symbols.push({ name: d.name.text, kind: 'function', line: lineOf(node.getStart(sf)), endLine: lineOf(node.end), exported });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // exported function declarations used as `export function` already covered; dedupe symbols
  const seen = new Set<string>();
  const uniqueSymbols = symbols.filter((s) => {
    const k = `${s.name}:${s.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    path: file.path,
    lang: file.lang,
    loc: countLoc(file.text),
    hash: hashText(file.text),
    isEntry: false,
    imports,
    symbols: uniqueSymbols,
    exports: [...exports],
  };
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isArrowOrFunctionInit(node: ts.VariableStatement): boolean {
  return node.declarationList.declarations.some((d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)));
}

function isTopLevelLike(node: ts.Node, sf: ts.SourceFile): boolean {
  // class methods: only count on classes we will surface (named, top level)
  let p: ts.Node | undefined = node.parent;
  while (p && p.parent) {
    if (ts.isClassDeclaration(p) && p.parent === sf) return true;
    p = p.parent;
  }
  return false;
}
