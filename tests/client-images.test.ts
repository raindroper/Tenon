import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentDrafts } from '../client/state/attachment-drafts.js';
import { prepareChatImage, type DraftImage } from '../client/lib/chat-images.js';
import { MAX_CHAT_FILE_BYTES } from '../shared/chat-files.js';

const file = (name: string) => new File(['fixture'], name, { type: 'image/png' });
const image = (id: string, size = 1): DraftImage => ({ id, name: `${id}.png`, blob: new Blob([new Uint8Array(size)]), url: `blob:${id}` });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('asynchronous image selection stays in its originating conversation', async () => {
  const operation = deferred<DraftImage>(); const drafts = createAttachmentDrafts(() => operation.promise, () => {}); const stop = drafts.activate();
  try {
    const adding = drafts.add('project', [file('project.png')]);
    assert.equal(drafts.get('project').pendingImages, 1); assert.deepEqual(drafts.get('personal-growth').images, []);
    operation.resolve(image('project')); await adding;
    assert.deepEqual(drafts.get('project').images.map(item => item.id), ['project']);
    assert.deepEqual(drafts.get('personal-growth').images, []); assert.equal(drafts.get('project').pendingImages, 0);
  } finally { stop(); }
});

test('accepted sends release only submitted image IDs and retain newer selections in each case', async () => {
  const revoked: string[] = []; const drafts = createAttachmentDrafts(async value => image(value.name), value => revoked.push(value)); const stop = drafts.activate();
  try {
    await drafts.add('project', [file('sent')]); const submitted = drafts.get('project').images.map(item => item.id);
    await drafts.add('project', [file('new')]); await drafts.add('personal-growth', [file('other')]);
    drafts.remove('project', submitted);
    assert.deepEqual(drafts.get('project').images.map(item => item.id), ['new']);
    assert.deepEqual(drafts.get('personal-growth').images.map(item => item.id), ['other']); assert.deepEqual(revoked, ['blob:sent']);
  } finally { stop(); }
  assert.deepEqual(revoked, ['blob:sent', 'blob:new', 'blob:other']);
});

test('pending decoding reserves image slots before a second selection can overfill a message', async () => {
  const first = deferred<DraftImage>(); let decoded = 0;
  const drafts = createAttachmentDrafts(async value => { decoded++; return decoded === 1 ? first.promise : image(value.name); }, () => {}); const stop = drafts.activate();
  try {
    const adding = drafts.add('project', [file('one'), file('two'), file('three'), file('four')]);
    await drafts.add('project', [file('five')]); assert.match(drafts.get('project').error, /最多/); assert.equal(decoded, 1);
    first.resolve(image('one')); await adding;
    assert.equal(drafts.get('project').images.length, 4); assert.equal(drafts.get('project').pendingImages, 0); assert.equal(decoded, 4);
  } finally { stop(); }
});

test('a failed or oversized selection rejects the whole batch and releases all temporary previews', async () => {
  const revoked: string[] = [];
  const drafts = createAttachmentDrafts(async value => {
    if (value.name === 'broken') throw new Error('Corrupt fixture');
    return image(value.name, value.name.startsWith('large') ? 512 * 1024 : 1);
  }, value => revoked.push(value)); const stop = drafts.activate();
  try {
    await drafts.add('project', [file('existing')]);
    await drafts.add('project', [file('created'), file('broken')]);
    assert.deepEqual(drafts.get('project').images.map(item => item.id), ['existing']); assert.match(drafts.get('project').error, /Corrupt fixture/);
    assert.deepEqual(revoked, ['blob:created']); assert.equal(drafts.get('project').pendingImages, 0);
    await drafts.add('personal-growth', [file('large1'), file('large2'), file('large3')]);
    assert.equal(drafts.get('personal-growth').images.length, 0); assert.match(drafts.get('personal-growth').error, /1 MB/);
    assert.deepEqual(revoked, ['blob:created', 'blob:large1', 'blob:large2', 'blob:large3']);
  } finally { stop(); }
});

test('unmount releases existing previews and discards late decode results across a restarted lifecycle', async () => {
  const late = deferred<DraftImage>(); const revoked: string[] = [];
  const drafts = createAttachmentDrafts(async value => value.name === 'late' ? late.promise : image(value.name), value => revoked.push(value));
  const stop = drafts.activate(); await drafts.add('project', [file('existing')]);
  const adding = drafts.add('project', [file('late')]); stop();
  const stopAgain = drafts.activate();
  try {
    await drafts.add('project', [file('new')]); late.resolve(image('late')); await adding;
    assert.deepEqual(drafts.get('project').images.map(item => item.id), ['new']); assert.equal(drafts.get('project').pendingImages, 0);
    assert.deepEqual(revoked, ['blob:existing', 'blob:late']);
    stop(); assert.deepEqual(drafts.get('project').images.map(item => item.id), ['new'], 'stale cleanup cannot clear a new lifecycle');
  } finally { stopAgain(); }
});

test('mixed selections keep original files, reserve their bytes during image decoding, and remove only acknowledged items', async () => {
  const screen = deferred<DraftImage>();
  const drafts = createAttachmentDrafts(() => screen.promise, () => {});
  const stop = drafts.activate();
  const workbook = new File([new Uint8Array(MAX_CHAT_FILE_BYTES)], '销售.xlsx');
  const second = new File([new Uint8Array(MAX_CHAT_FILE_BYTES)], 'events.csv', { type: 'text/csv' });
  const later = new File(['a'], 'notes.txt', { type: 'text/plain' });
  try {
    const mixed = drafts.add('project', [file('screen.png'), workbook]);
    await drafts.add('project', [second, later]);
    assert.match(drafts.get('project').error, /20 MiB/);
    assert.deepEqual(drafts.get('project').files, []);
    await drafts.add('other', [later]);
    screen.resolve(image('screen'));
    await mixed;
    const submitted = drafts.get('project');
    assert.equal(submitted.files[0].file, workbook);
    assert.deepEqual(submitted.images.map(image => image.id), ['screen']);
    await drafts.add('project', [second]);
    drafts.remove('project', [...submitted.images, ...submitted.files].map(item => item.id));
    assert.deepEqual(drafts.get('project').files.map(({ file }) => file.name), ['events.csv']);
    assert.deepEqual(drafts.get('other').files.map(({ file }) => file.name), ['notes.txt']);
  } finally { stop(); }
});

test('browser preparation resizes and recompresses large inputs while closing decoded bitmaps', async context => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  context.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });
  const encodings: Array<{ type: string; quality?: number }> = []; let closed = 0; let decodeCount = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(callback: (blob: Blob) => void, type: string, quality?: number) {
    encodings.push({ type, quality }); callback(new Blob([new Uint8Array(type === 'image/png' ? 600_000 : 100_000)], { type }));
  } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { decodeCount++; return { width: 4000, height: 2000, close() { closed++; } }; } });
  context.mock.method(URL, 'createObjectURL', () => 'blob:normalized');
  const result = await prepareChatImage(file('screen.png'));
  assert.equal(canvas.width, 2048); assert.equal(canvas.height, 1024); assert.equal(closed, 1);
  assert.deepEqual(encodings, [{ type: 'image/png', quality: undefined }, { type: 'image/webp', quality: .86 }]);
  assert.equal(result.blob.type, 'image/webp'); assert.equal(result.url, 'blob:normalized');
  await assert.rejects(prepareChatImage(new File(['fixture'], 'bad.svg', { type: 'image/svg+xml' })), /仅支持/);
  assert.equal(decodeCount, 1, 'unsupported content types are rejected before decoding');
});
