import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../../server/store.js';
import { V2Coordinator } from '../../server/v2/coordinator.js';
import { prepareImages } from '../../server/v2/images.js';
import { MockLanguageModelV4 } from './model.js';

const [directory, action] = process.argv.slice(2);
if (!directory || !['seed', 'verify'].includes(action)) throw new Error('Expected a fixture directory and seed/verify action.');
const store = new Store(directory); store.getApiKey = () => undefined;
const model = new MockLanguageModelV4({ doGenerate: async () => assert.fail('Offline restore cannot invoke a provider.') });
const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
try {
  if (action === 'seed') {
    const scene = await runtime.createCase({ title: 'Backup fixture', objective: '', domain: 'fixture' });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#315143' } }).png().toBuffer();
    const images = await prepareImages([{ name: 'preserved.png', data: png.toString('base64') }]);
    const message = { id: randomUUID(), role: 'user' as const, content: 'Preserve the original image and media.', caseId: scene.id,
      createdAt: new Date().toISOString(), attachments: images.map(image => image.attachment) };
    store.insertOwnerMessage(message, images);
    const mediaDirectory = join(directory, 'media'); await mkdir(mediaDirectory, { recursive: true });
    await writeFile(join(mediaDirectory, 'original.bin'), Buffer.from('PRIVATE_MEDIA_BACKUP_SENTINEL'));
    await writeFile(join(directory, 'fixture-expectations.json'), JSON.stringify({ messages: store.list('messages'), cases: await runtime.listCases(),
      migration: store.getMeta('kernel.migration', null), imageId: images[0].attachment.id, image: images[0].data.toString('base64') }));
  } else {
    const expected = JSON.parse(await readFile(join(directory, 'fixture-expectations.json'), 'utf8'));
    assert.deepEqual(store.list('messages'), expected.messages); assert.deepEqual(await runtime.listCases(), expected.cases);
    assert.deepEqual(store.getMeta('kernel.migration', null), expected.migration);
    assert.equal(store.readImage(expected.imageId)?.data.toString('base64'), expected.image);
    assert.equal((await readFile(join(directory, 'media', 'original.bin'))).toString(), 'PRIVATE_MEDIA_BACKUP_SENTINEL');
    assert.equal(store.getSettings().enabled, false); assert.equal(store.list('runs').length, 0);
  }
} finally { await runtime.close(); store.close(); }
