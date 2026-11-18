import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { MailAttachments } from '../server/connectors/mail-attachments.js';
import { EWS_MAX_ATTACHMENT_BYTES } from '../shared/ews.js';
import type { TaskRecord } from '../shared/task-consent.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-files-'));
  const store = new Store(directory); const files = new MailAttachments(store, directory);
  const scope = { caseId: 'case-one', connectionId: 'mail-one', credentialRevision: 2 };
  const save = (name = 'report.txt') => files.save({ ...scope, name, contentType: 'text/plain', bytes: Buffer.from('private fixture') });
  return { directory, store, files, scope, save };
}
test('mail files bind exact case, connection, credential revision and content, never public paths', async () => {
  const f = await fixture();
  try {
    const item = f.save(); assert.equal('path' in item, false);
    assert.equal(item.sha256, createHash('sha256').update('private fixture').digest('hex'));
    assert.equal(f.files.select(item.id, f.scope, item.sha256).size, item.size);
    for (const scope of [{ ...f.scope, caseId: 'other' }, { ...f.scope, connectionId: 'other' }, { ...f.scope, credentialRevision: 3 }]) assert.throws(() => f.files.select(item.id, scope));
    assert.throws(() => f.files.select(item.id, f.scope, '0'.repeat(64)));
    for (const name of ['../secret', 'folder\\secret', 'bad\r\nfile']) assert.throws(() => f.save(name));
    assert.throws(() => f.files.select('../secret', f.scope));
    assert.throws(() => f.files.save({ ...f.scope, name: 'large.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(EWS_MAX_ATTACHMENT_BYTES + 1) }));
    await writeFile(join(f.files.root, item.id), 'tampered value');
    assert.throws(() => f.files.select(item.id, f.scope, item.sha256), /文件已变化/);
  } finally { f.store.close(); }
});
test('bound attachments survive expiry and cannot be removed while unbound files expire', async () => {
  const f = await fixture();
  try {
    const keep = f.save('bound.txt'); const expired = f.save('unbound.txt'); f.files.pin([keep.id], 'task-one');
    const records = f.store.getMeta<Array<Record<string, unknown>>>('connectors.ews.mail-attachments', []);
    f.store.setMeta('connectors.ews.mail-attachments', records.map(item => ({ ...item, createdAt: '2000-01-01T00:00:00Z' })));
    f.files.cleanup(); assert.ok(f.files.select(keep.id, f.scope));
    assert.throws(() => f.files.select(expired.id, f.scope));
    assert.throws(() => f.files.remove(keep.id, f.scope), /已绑定/);
  } finally { f.store.close(); }
});
test('mail custody rejects hard links so a local file cannot replace an approved upload', async () => {
  const f = await fixture();
  try {
    const item = f.save(); await link(join(f.files.root, item.id), join(f.directory, 'linked-file'));
    assert.throws(() => f.files.select(item.id, f.scope), /文件已变化/);
  } finally { f.store.close(); }
});
test('durable queued task scope pins uploads before dispatch; settled tasks release bytes while retaining metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-custody-lifecycle-')); const store = new Store(directory);
  let tasks: TaskRecord[] = []; const files = new MailAttachments(store, directory, () => tasks);
  const scope = { caseId: 'case-one', connectionId: 'mail-one', credentialRevision: 2 };
  try {
    const file = files.save({ ...scope, name: 'queued.txt', contentType: 'text/plain', bytes: Buffer.from('queued bytes') });
    tasks = [{ id: 'queued-task', revision: 1, state: 'approved', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z',
      spec: { caseId: scope.caseId, title: 'queued', objective: 'send', expectedOutput: 'receipt', capabilities: ['mail'],
        mail: { ...scope, mode: 'send', subject: 'queued', body: 'queued', to: ['recipient@example.test'], cc: [], bcc: [], protection: 'plaintext', attachments: [{ id: file.id, sha256: file.sha256 }] } } }];
    const records = store.getMeta<Array<Record<string, unknown>>>('connectors.ews.mail-attachments', []);
    store.setMeta('connectors.ews.mail-attachments', records.map(item => ({ ...item, createdAt: '2000-01-01T00:00:00Z' })));
    files.cleanup(); assert.ok(files.select(file.id, scope));
    assert.throws(() => files.remove(file.id, scope), /已绑定/);
    tasks[0] = { ...tasks[0], state: 'completed' }; files.cleanup();
    assert.throws(() => files.select(file.id, scope));
    const retained = store.getMeta<Array<Record<string, unknown>>>('connectors.ews.mail-attachments', []);
    assert.equal(retained[0].sha256, file.sha256); assert.ok(retained[0].removedAt);
  } finally { store.close(); }
});
