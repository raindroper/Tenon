import test from 'node:test';
import assert from 'node:assert/strict';
import { commandAccessText, operationStateText } from '../client/lib/local-command.js';
import { taskDeviceCommandSpecSchema } from '../shared/local-device.js';

test('retired exact-command receipts retain their readable scope and truthful stop labels', () => {
  const command = taskDeviceCommandSpecSchema.parse({ deviceId: 'device', executable: 'C:\\Tools\\node.exe', args: [],
    timeoutMs: 60000, access: { kind: 'directory', root: 'D:\\Work', readOnly: true } });
  assert.equal(commandAccessText(command), '只读 D:\\Work');
  assert.equal(commandAccessText({ ...command, access: { kind: 'scratch' } }), '本次任务的临时空间');
  assert.match(operationStateText.cancel_requested, /等待设备确认/);
  assert.match(operationStateText.unknown, /待核对/);
  assert.notEqual(operationStateText.cancelled, operationStateText.cancel_requested);
});
