import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteRoot, '..');
const outputRoot = join(siteRoot, '.cloudbase-static');
const outputDir = join(outputRoot, 'out');
const blockedOutputNames = ['__auth', 'cloud-admin'];

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function copySource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const rel = relative(siteRoot, entry);
      if (!rel) return true;
      const segments = rel.split(sep);
      if (segments.some((segment) => ['.git', '.next', 'node_modules', 'out', 'dist', '.cloudbase-static'].includes(segment))) return false;
      if (segments.some((segment) => segment.startsWith('.env'))) return false;
      return true;
    },
  });
}

async function verifyOutput(path) {
  for (const protectedName of blockedOutputNames) {
    try {
      await readFile(join(path, protectedName, 'index.html'));
      throw new Error(`Static output contains protected namespace ${protectedName}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Static output contains')) throw error;
    }
  }
  for (const required of ['index.html', '404.html', 'auth/wechat/callback/index.html']) {
    try { await readFile(join(path, required)); }
    catch { throw new Error(`Static output is missing ${required}`); }
  }
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  const workRoot = await mkdtemp(join(tmpdir(), 'guoman-cloudbase-static-work-'));
  const siteCopy = join(workRoot, 'guoman-site');
  const repoCopy = workRoot;
  try {
    await copySource(siteRoot, siteCopy);
    await mkdir(join(repoCopy, 'cloudbase'), { recursive: true });
    await cp(join(repoRoot, 'cloudbase', 'shared'), join(repoCopy, 'cloudbase', 'shared'), { recursive: true });
    await symlink(join(siteRoot, 'node_modules'), join(siteCopy, 'node_modules'), 'dir');
    const config = await readFile(join(siteCopy, 'next.config.ts'), 'utf8');
    if (!config.includes('CLOUDBASE_STATIC_BUILD')) throw new Error('Static build marker is missing from copied Next config.');
    const env = { ...process.env, CLOUDBASE_STATIC_BUILD: '1' };
    delete env.NODE_OPTIONS;
    await run(process.execPath, [join(siteCopy, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', '--webpack'], siteCopy, env);
    const builtOut = join(siteCopy, 'out');
    await verifyOutput(builtOut);
    for (const name of blockedOutputNames) {
      try { await readdir(join(builtOut, name)); throw new Error(`Static output contains protected namespace ${name}`); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('Static output contains')) throw error;
      }
    }
    const staging = join(outputRoot, `.out-${process.pid}`);
    await rm(staging, { recursive: true, force: true });
    await cp(builtOut, staging, { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(dirname(outputDir), { recursive: true });
    await rename(staging, outputDir);
    console.log(`CloudBase 静态产物已生成：${outputDir}`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
