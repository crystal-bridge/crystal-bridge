import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Project } from '@crystal-bridge/protocol';

/** A folder a session ran in, with when (epoch ms): from the CLI's transcripts. */
export interface FolderUse {
  cwd: string;
  updatedAt: number;
}

async function gitReposUnder(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    if ((await stat(path).catch(() => undefined))?.isDirectory() && existsSync(join(path, '.git'))) repos.push(path);
  }
  return repos;
}

/**
 * The node's projects for the New session picker: git repositories directly under each root, plus any other
 * folder a session used that still exists. Most recently used first, then the rest by name.
 */
export async function listProjects(
  roots: readonly string[],
  used: readonly FolderUse[],
  { limit = 100 } = {},
): Promise<Project[]> {
  const lastUsed = new Map<string, number>();
  for (const { cwd, updatedAt } of used) lastUsed.set(cwd, Math.max(lastUsed.get(cwd) ?? 0, updatedAt));

  const paths = new Set<string>();
  for (const root of roots) for (const repo of await gitReposUnder(root)) paths.add(repo);
  for (const cwd of lastUsed.keys()) if (existsSync(cwd)) paths.add(cwd);

  const projects: Project[] = [...paths].map((path) => {
    const when = lastUsed.get(path);
    return when === undefined ? { path, name: basename(path) } : { path, name: basename(path), lastUsed: when };
  });
  projects.sort((a, b) => (b.lastUsed ?? -1) - (a.lastUsed ?? -1) || a.name.localeCompare(b.name));
  return projects.slice(0, limit);
}
