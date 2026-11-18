/** Bundled, task-bound PreToolUse hook. Every failure produces an explicit upstream denial. */
async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk.toString();
  JSON.parse(input);
  const address = process.env.RAE_PROJECT_GATE;
  const token = process.env.RAE_PROJECT_TOKEN;
  if (!address || !token) throw new Error('项目许可核验入口不可用。');
  const endpoint = new URL(address);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('项目许可核验地址无效。');
  const response = await fetch(new URL('/authorize', endpoint), { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: input, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    throw new Error(typeof value?.error?.message === 'string' && value.error.message.length <= 2000
      ? value.error.message : '任务许可核验未完成（HTTP ' + response.status + '），已拒绝继续执行。');
  }
  process.stdout.write('{}');
}
void main().catch(error => {
  const reason = error instanceof Error ? error.message : '项目许可核验失败。';
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  // Blocking JSON is a successful hook response. A nonzero wrapper exit can be
  // interpreted upstream as a hook failure and let the original tool continue.
});
