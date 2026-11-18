import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { MxcProcess } from '@microsoft/mxc-sdk/v1';
import { LocalHand } from '../desktop/hand.js';
import { OperationJournal } from '../desktop/journal.js';
import type { MxcAdapter } from '../desktop/mxc.js';
import { specHash } from '../desktop/security.js';
import { deviceDirectoryEntriesCapability, deviceDirectoryLookupCapability, deviceDirectoryLookupResultSchema, type DeviceCommandSpec, type DeviceExecuteMessage, type DeviceOperationReceipt } from '../shared/local-device.js';

const windows = { skip: process.platform !== 'win32' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function executeMessage(operationId: string, spec: DeviceCommandSpec): DeviceExecuteMessage {
  return { kind: 'execute', operationId, taskId: 'approved-task', taskRevision: 1, runId: 'approved-run',
    spec, specHash: specHash(spec), issuedAt: new Date().toISOString(), deadline: Date.now() + 30000 };
}

async function fixture(work: (directory: string, privateDirectory: string, journal: OperationJournal) => Promise<void>): Promise<void> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'rae-task-scope-'));
  const privateDirectory = path.join(directory, 'private');
  await mkdir(privateDirectory);
  try { await work(directory, privateDirectory, new OperationJournal(path.join(privateDirectory, 'journal'))); }
  finally {
    const target = await realpath(directory);
    assert.equal(path.dirname(target), parent);
    assert.equal(target, directory);
    await rm(target, { recursive: true, force: true });
  }
}

test('Downloads lookup works after admission without MXC or preset grants and ignores subdirectories and junctions', windows, async () => {
  await fixture(async (directory, privateDirectory, journal) => {
    const downloads = path.join(directory, 'Redirected Downloads');
    const outside = path.join(directory, 'outside');
    await mkdir(downloads);
    await mkdir(outside);
    await writeFile(path.join(downloads, 'Archive-Old.DOCX'), 'old fixture');
    await writeFile(path.join(downloads, 'archive-new.docx'), 'new fixture');
    await writeFile(path.join(downloads, 'other.txt'), 'excluded');
    await writeFile(path.join(outside, 'Archive-Hidden.docx'), 'never traverse');
    await utimes(path.join(downloads, 'Archive-Old.DOCX'), new Date(1000), new Date(1000));
    await symlink(outside, path.join(downloads, 'linked'), 'junction');
    const receipts: DeviceOperationReceipt[] = [];
    let admissions = 0;
    const hand = new LocalHand('device', [], journal, undefined, privateDirectory,
      async receipt => { receipts.push(receipt); }, undefined, async () => { admissions++; }, downloads);
    assert.deepEqual(await hand.advertisedCapabilities([]), [deviceDirectoryLookupCapability, deviceDirectoryEntriesCapability]);
    const message = executeMessage('downloads', { kind: 'list_directory', deviceId: 'device', root: 'windows-downloads',
      extension: 'docx', nameContains: 'ARCHIVE', limit: 1, timeoutMs: 10000 });
    hand.accept(message);
    await hand.flushReceipts();
    assert.equal(admissions, 1);
    assert.deepEqual(receipts.map(receipt => receipt.state), ['running', 'completed']);
    const result = deviceDirectoryLookupResultSchema.parse(JSON.parse(receipts[1].stdout!));
    assert.equal(result.directory, downloads);
    assert.deepEqual(result.files.map(file => file.name), ['archive-new.docx']);
    assert.equal(result.files[0].size, 11);
    assert.equal(result.scanned, 4);
    assert.equal(result.truncated, true);
    hand.accept(message);
    await hand.flushReceipts();
    assert.equal(admissions, 1);
    assert.equal(receipts.at(-1)?.stdout, receipts[1].stdout);
  });
});

test('directory identity must still match after admission and before listing', windows, async () => {
  await fixture(async (directory, privateDirectory, journal) => {
    const approved = path.join(directory, 'approved');
    const outside = path.join(directory, 'outside');
    await mkdir(approved);
    await mkdir(outside);
    await writeFile(path.join(outside, 'outside-secret.txt'), 'outside');
    const hand = new LocalHand('device', [], journal, undefined, privateDirectory, async () => {}, undefined, async () => {
      await rename(approved, path.join(directory, 'approved-original'));
      await symlink(outside, approved, 'junction');
    });
    hand.accept(executeMessage('replaced', { kind: 'list_directory', deviceId: 'device', root: approved, limit: 100, timeoutMs: 10000 }));
    await hand.flushReceipts();
    const result = (await journal.get('replaced'))?.receipt;
    assert.equal(result?.state, 'failed');
    assert.equal(result.stdout, undefined);
    assert.match(result.error ?? '', /重定向/);
  });
});

test('native folder lookup returns matching immediate directories without shell, private data, links or recursion', windows, async () => {
  await fixture(async (directory, privateDirectory, journal) => {
    await mkdir(path.join(directory, 'AnotherRae'));
    await mkdir(path.join(directory, 'AnotherRae', 'nested'));
    await mkdir(path.join(directory, '中文项目'));
    await writeFile(path.join(directory, 'AnotherRae.txt'), 'not a directory');
    await symlink(privateDirectory, path.join(directory, 'AnotherRae-link'), 'junction');
    const receipts: DeviceOperationReceipt[] = [];
    const hand = new LocalHand('device', [], journal, undefined, privateDirectory, async receipt => { receipts.push(receipt); }, undefined, async () => {});
    hand.accept(executeMessage('folders', { kind: 'list_directory', deviceId: 'device', root: directory,
      entryType: 'directory', nameContains: 'another', limit: 100, timeoutMs: 10000 }));
    await hand.flushReceipts();
    const result = deviceDirectoryLookupResultSchema.parse(JSON.parse(receipts.at(-1)!.stdout!));
    assert.equal(receipts.at(-1)!.state, 'completed'); assert.equal(result.entryType, 'directory');
    assert.deepEqual(result.files.map(entry => entry.name), ['AnotherRae']);
    hand.accept(executeMessage('all-folders', { kind: 'list_directory', deviceId: 'device', root: directory,
      entryType: 'directory', limit: 100, timeoutMs: 10000 }));
    await hand.flushReceipts();
    const all = deviceDirectoryLookupResultSchema.parse(JSON.parse(receipts.at(-1)!.stdout!));
    assert.deepEqual(all.files.map(entry => entry.name).sort(), ['AnotherRae', '中文项目'].sort());
  });
});

test('task scratch is outside protected data and remains until native wait and both streams settle', windows, async () => {
  await fixture(async (directory, privateDirectory, journal) => {
    const executable = path.join(directory, 'fixture.exe');
    await writeFile(executable, 'test-only image');
    const spawned = deferred<string>();
    const wait = deferred<{ exitCode: number; timedOut: boolean }>();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const adapter = {
      getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }),
      spawn: async request => {
        assert.deepEqual(request.filesystem?.readwritePaths, [request.workingDirectory]);
        assert(!request.filesystem?.readonlyPaths?.includes(path.dirname(executable)));
        spawned.resolve(request.workingDirectory!);
        return { standardOutput: stdout, standardError: stderr, wait: () => wait.promise, kill() {}, dispose() {} } as unknown as MxcProcess;
      },
    } satisfies MxcAdapter;
    const hand = new LocalHand('device', [], journal, adapter, privateDirectory, async () => {}, undefined, async () => {});
    hand.accept(executeMessage('scratch', { deviceId: 'device', executable, args: [], timeoutMs: 10000, access: { kind: 'scratch' } }));
    const scratch = await spawned.promise;
    assert.equal(path.dirname(scratch), path.join(directory, 'private-scratch'));
    assert.equal((await stat(scratch)).isDirectory(), true);
    wait.resolve({ exitCode: 0, timedOut: false });
    stdout.end('result');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await stat(scratch)).isDirectory(), true);
    stderr.end();
    await hand.flushReceipts();
    await assert.rejects(stat(scratch), { code: 'ENOENT' });
    assert.equal((await journal.get('scratch'))?.receipt.stdout, 'result');
  });
});

test('indeterminate task launch retains its scratch and blocks stop acknowledgement', windows, async () => {
  await fixture(async (directory, privateDirectory, journal) => {
    const executable = path.join(directory, 'fixture.exe');
    await writeFile(executable, 'test-only image');
    let scratch: string | undefined;
    const adapter = {
      getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }),
      spawn: async request => { scratch = request.workingDirectory; throw new Error('fixture native launch uncertainty'); },
    } satisfies MxcAdapter;
    const hand = new LocalHand('device', [], journal, adapter, privateDirectory, async () => {}, undefined, async () => {});
    hand.accept(executeMessage('uncertain', { deviceId: 'device', executable, args: [], timeoutMs: 10000, access: { kind: 'scratch' } }));
    await hand.flushReceipts();
    assert.equal((await journal.get('uncertain'))?.receipt.state, 'unknown');
    assert.equal((await stat(scratch!)).isDirectory(), true);
    await assert.rejects(hand.stop(), /未确认/);
  });
});
