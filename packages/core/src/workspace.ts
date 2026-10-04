/**
 * The workspace: which projects the developer has opened, and how a new one gets created.
 *
 * Kept in ~/.config/syscode/workspace.json so it is per-user and outside any project —
 * the app has a life outside a single repository, like an editor does.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RecentProject, WorkspaceInfo } from './types.ts';
import { workspaceDir } from './config.ts';

const MAX_RECENT = 20;

interface WorkspaceFile {
  recent: RecentProject[];
}

function workspaceFile(): string {
  return path.join(workspaceDir(), 'workspace.json');
}

export function defaultParentDir(): string {
  const projects = path.join(homedir(), 'projects');
  return existsSync(projects) ? projects : homedir();
}

export function loadWorkspace(): WorkspaceFile {
  try {
    const raw = JSON.parse(readFileSync(workspaceFile(), 'utf8')) as WorkspaceFile;
    return { recent: Array.isArray(raw.recent) ? raw.recent : [] };
  } catch {
    return { recent: [] };
  }
}

function saveWorkspace(ws: WorkspaceFile): void {
  mkdirSync(workspaceDir(), { recursive: true });
  writeFileSync(workspaceFile(), JSON.stringify({ recent: ws.recent.slice(0, MAX_RECENT) }, null, 2));
}

/** Recent projects, most recent first, with a flag for directories that have vanished. */
export function recentProjects(): RecentProject[] {
  const ws = loadWorkspace();
  return ws.recent.map((p) => ({ ...p, missing: !existsSync(p.path) }));
}

export function rememberProject(dir: string): void {
  const abs = path.resolve(dir);
  const ws = loadWorkspace();
  const entry: RecentProject = { path: abs, name: path.basename(abs), openedAt: new Date().toISOString() };
  ws.recent = [entry, ...ws.recent.filter((p) => p.path !== abs)];
  saveWorkspace(ws);
}

export function forgetProject(dir: string): void {
  const abs = path.resolve(dir);
  const ws = loadWorkspace();
  ws.recent = ws.recent.filter((p) => p.path !== abs);
  saveWorkspace(ws);
}

export interface CreateResult {
  path: string;
  files: string[];
}

export class WorkspaceError extends Error {}

/**
 * Scaffold a new project so the map has something honest to show from the first second.
 * Refuses to write into a directory that already has files — never clobbers.
 */
export function createProject(input: { name: string; parentDir?: string; template?: 'empty' | 'typescript' }): CreateResult {
  const name = input.name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new WorkspaceError('Give the project a name.');
  const parent = path.resolve(input.parentDir?.trim() || defaultParentDir());
  if (!existsSync(parent)) throw new WorkspaceError(`No such directory: ${parent}`);
  if (!statSync(parent).isDirectory()) throw new WorkspaceError(`${parent} is not a directory.`);

  const dir = path.join(parent, name);
  if (existsSync(dir)) {
    const entries = readdirSync(dir).filter((e) => e !== '.syscode');
    if (entries.length) throw new WorkspaceError(`${dir} already exists and is not empty.`);
  }
  mkdirSync(dir, { recursive: true });

  const template = input.template ?? 'typescript';
  const files: string[] = [];
  const write = (rel: string, body: string) => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    files.push(rel);
  };

  write('README.md', `# ${name}\n\nStarted from the SysCode desktop app. The map starts empty and grows as you\nand the agent design the system.\n`);
  write('.gitignore', 'node_modules/\ndist/\n.syscode/\n');

  if (template === 'typescript') {
    write('package.json', `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/main.ts' } }, null, 2)}\n`);
    write('src/main.ts', `/**\n * The first piece of ${name}.\n *\n * Add nodes to the map before writing more code: describe the parts, connect them,\n * and let the agent fill them in.\n */\nexport function main(): void {\n  console.log('${name} is running.');\n}\n\nmain();\n`);
  }

  return { path: dir, files };
}

/** Everything the start screen needs. */
export function workspaceInfo(current: WorkspaceInfo['current']): WorkspaceInfo {
  return {
    current,
    recent: recentProjects().filter((p) => p.path !== current.root),
    defaultParentDir: defaultParentDir(),
  };
}
