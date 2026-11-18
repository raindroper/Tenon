import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MEMORY_EMBEDDING_DIMENSION = 512;
const modelId = 'BAAI/bge-small-zh-v1.5';
const modelName = 'model_optimized.onnx';
const tokenWindow = 512;
const batchSize = 16;
// Qdrant/bge-small-zh-v1.5 revision 46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59.
const modelFiles = [
  [modelName, 94781076, '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38'],
  ['config.json', 739, '9088751d39abbf86ec3d19ffca92ad62ad19075f7e59712e6c71217fa125d1d3'],
  ['special_tokens_map.json', 125, 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'],
  ['tokenizer_config.json', 367, 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'],
  ['tokenizer.json', 439125, '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'],
] as const;

export function localMemoryModelFileNames(): readonly string[] {
  return modelFiles.map(([file]) => file);
}

export function resolveMemoryModelDirectory(dataDir: string, override = process.env.RAE_EMBEDDING_MODEL_DIR): string {
  return resolve(override?.trim() || join(dataDir, 'models', 'bge-small-zh-v1.5'));
}

export function hasLocalMemoryModel(modelDirectory: string): boolean {
  try {
    return modelFiles.every(([file, size]) => {
      const stat = statSync(join(modelDirectory, file), { throwIfNoEntry: false });
      return stat?.isFile() && stat.size === size;
    });
  } catch { return false; }
}

export async function verifyLocalMemoryModel(modelDirectory: string): Promise<void> {
  if (!hasLocalMemoryModel(modelDirectory)) throw new Error('本地记忆模型未准备好，请先运行 npm run prepare:memory-model。');
  for (const [file, , expected] of modelFiles) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(modelDirectory, file))) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error('本地记忆模型与已验证版本不一致，请使用正确的权重目录。');
  }
}

interface NativeMemoryEmbedding {
  countTruncated(values: string[], batchSize: number): Promise<{ count: number }>;
  embed(values: string[], batchSize: number): AsyncIterable<ArrayLike<number>[]>;
}

async function loadNativeModel(modelDirectory: string): Promise<NativeMemoryEmbedding> {
  await verifyLocalMemoryModel(modelDirectory);
  const { FlagEmbedding, EmbeddingModel } = await import('@mastra/fastembed');
  return FlagEmbedding.init({ model: EmbeddingModel.CUSTOM, maxLength: tokenWindow, modelName, modelAbsoluteDirPath: modelDirectory });
}

export function createLocalMemoryEmbedder(
  modelDirectory: string, loadModel: (directory: string) => Promise<NativeMemoryEmbedding> = loadNativeModel,
): EmbeddingModelV4 {
  let native: NativeMemoryEmbedding | undefined;
  let tail = Promise.resolve();
  return {
    specificationVersion: 'v4',
    provider: 'mastra.fastembed',
    modelId,
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: false,
    async doEmbed({ values, dimensions, abortSignal }) {
      abortSignal?.throwIfAborted();
      if (dimensions !== undefined && dimensions !== MEMORY_EMBEDDING_DIMENSION) throw new Error('本地记忆模型仅支持 512 维嵌入。');
      if (!values.length) return { embeddings: [], warnings: [] };
      const run = tail.then(async () => {
        abortSignal?.throwIfAborted();
        native ??= await loadModel(modelDirectory);
        abortSignal?.throwIfAborted();
        const { count } = await native.countTruncated(values, batchSize);
        abortSignal?.throwIfAborted();
        if (count) throw new Error('本地记忆嵌入输入超出模型窗口，请缩短后再试。');
        const embeddings: number[][] = [];
        for await (const batch of native.embed(values, batchSize)) {
          abortSignal?.throwIfAborted();
          for (const vector of batch) {
            const numbers = Array.from(vector);
            if (numbers.length !== MEMORY_EMBEDDING_DIMENSION || !numbers.every(Number.isFinite)) {
              throw new Error('本地记忆模型返回了无效嵌入。');
            }
            embeddings.push(numbers);
          }
        }
        abortSignal?.throwIfAborted();
        if (embeddings.length !== values.length) throw new Error('本地记忆模型返回的嵌入数量不完整。');
        return { embeddings, warnings: [] };
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
