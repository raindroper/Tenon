import { posix, win32 } from 'node:path';

/** The device resolves junctions before calling this with actual workspace paths. */
export function projectRootsOverlap(left: string, right: string, platform: 'win32' | 'linux' = 'win32'): boolean {
  const paths = platform === 'linux' ? posix : win32;
  const contains = (root: string, target: string) => {
    const relative = paths.relative(root, target);
    return relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
  };
  return contains(left, right) || contains(right, left);
}
