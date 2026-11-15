import path from 'node:path';
import fs from 'node:fs/promises';

export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

async function actual(file) {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await actual(parent), path.basename(file));
  }
}

/** All installation writes stay in a real, explicitly selected memory root. */
export async function installPath(root, relative) {
  const resolved = path.resolve(root), real = await fs.realpath(resolved);
  if (real.toLowerCase() !== resolved.toLowerCase()) throw Error('安装目录不能经过链接或目录别名');
  const file = path.resolve(resolved, relative), target = await actual(file);
  if (!inside(real, target) || path.relative(file, target) !== '') throw Error('安装路径必须位于当前记忆库内，不能经过链接');
  return file;
}
