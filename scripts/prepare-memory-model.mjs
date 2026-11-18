import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { localMemoryModelFileNames, resolveMemoryModelDirectory, verifyLocalMemoryModel } from '../server/v2/embedding.ts';

async function prepare() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--from' || !args[1].trim())) {
    throw new Error('用法：npm run prepare:memory-model -- --from <已下载目录>');
  }
  const source = args.length ? await realpath(args[1]) : undefined;
  const explicitDirectory = process.env.RAE_EMBEDDING_MODEL_DIR;
  const fileEnv = !explicitDirectory?.trim() && existsSync('.env') ? parseEnv(await readFile('.env', 'utf8')) : {};
  const dataDir = (process.env.RAE_DATA_DIR ?? fileEnv.RAE_DATA_DIR) || 'data';
  const directory = resolveMemoryModelDirectory(dataDir, explicitDirectory ?? fileEnv.RAE_EMBEDDING_MODEL_DIR ?? '');
  if (existsSync(directory)) {
    await verifyLocalMemoryModel(directory);
    console.info('本地记忆模型已准备好。');
    return;
  }
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await realpath(parent);
  const staging = await mkdtemp(join(stagingRoot, '.memory-model-'));
  if (dirname(staging) !== stagingRoot) throw new Error('无法安全创建模型准备目录。');
  try {
    let prepared;
    if (source) {
      prepared = join(staging, 'model');
      await mkdir(prepared);
      for (const file of localMemoryModelFileNames()) await copyFile(join(source, file), join(prepared, file));
    } else {
      const { EmbeddingModel, FlagEmbedding } = await import('@mastra/fastembed');
      prepared = String(await FlagEmbedding.retrieveModel(EmbeddingModel.BGESmallZH, staging));
    }
    await verifyLocalMemoryModel(prepared);
    await rename(prepared, directory);
    console.info(source ? '本地记忆模型已离线导入并验证。' : '本地记忆模型已下载并验证。');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

try { await prepare(); }
catch (error) { console.error(error instanceof Error ? error.message : '准备本地记忆模型失败。'); process.exitCode = 1; }
