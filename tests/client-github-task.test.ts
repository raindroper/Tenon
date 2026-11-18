import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubTaskResult, safeGitHubLink } from '../client/components/GitHubTaskResult.js';
import type { TaskRecord } from '../shared/task-consent.js';
import type { GitHubOperationState } from '../shared/github.js';

const timestamp = '2026-11-09T12:00:00.000Z';
const sha = 'a'.repeat(40);
function task(state?: GitHubOperationState): TaskRecord {
  return { id: 'task', revision: 2, state: 'completed', createdAt: timestamp, updatedAt: timestamp,
    spec: { caseId: 'scene', title: '更新指定文件和事项', objective: '完成明确委托', expectedOutput: '实际提交记录', capabilities: ['github'],
      github: { connectionId: 'connection', repository: 'owner/repo', repositoryId: 123, credentialRevision: 4,
        operations: ['commit', 'issue-update', 'comment', 'pull-request-update'], branch: 'codex/change', baseBranch: 'main',
        files: ['src/app.ts', 'README.md'], issueNumbers: [12], pullRequestNumbers: [34], issueFields: ['title', 'labels'], pullRequestFields: ['body'] } },
    ...(state ? { githubReceipts: [{ operationId: 'operation', tool: 'push_files', state, updatedAt: timestamp, sha,
      url: `https://github.com/owner/repo/commit/${sha}`, number: 34 }] } : {}) };
}
function render(value: TaskRecord) {
  return renderToStaticMarkup(createElement(GitHubTaskResult, { task: value, timezone: 'Asia/Shanghai' }));
}

test('GitHub task details expose exact repository, branches, files, targets and field limits', () => {
  const html = render(task());
  assert.match(html, /本次任务仓库/);
  assert.match(html, /本次任务动作/);
  for (const value of ['owner/repo', 'codex/change', 'main', 'src/app.ts', 'README.md', '#12', '#34', '提交代码', '修改 Issue', '添加评论', '修改 PR', '标题', '标签', '正文']) {
    assert.ok(html.includes(value), `Missing authorized scope: ${value}`);
  }
  assert.match(html, /尚未取得 GitHub 的真实提交回执/);
  assert.doesNotMatch(html, /GitHub 已接受提交/);
});

test('account commit scope explains goal-based files without widening explicit or legacy file limits', () => {
  const value = task();
  value.spec.github = { ...value.spec.github!, accountId: 456, operations: ['commit'], files: [] };
  assert.match(render(value), /按任务目标处理本次仓库\/分支中的文件/);
  value.spec.github.files = ['src/fix.ts'];
  assert.match(render(value), /src\/fix.ts/);
  assert.doesNotMatch(render(value), /按任务目标处理本次仓库\/分支中的文件/);
  value.spec.github.files = []; delete value.spec.github.accountId;
  assert.doesNotMatch(render(value), /按任务目标处理本次仓库\/分支中的文件/);
  value.spec.github.accountId = 456; value.spec.github.operations = ['issue-create'];
  assert.doesNotMatch(render(value), /按任务目标处理本次仓库\/分支中的文件/);
});

test('GitHub result UI uses durable receipt states and never turns unknown or failed into success', () => {
  const submitted = render(task('submitted'));
  assert.match(submitted, /GitHub 已接受提交/);
  assert.match(submitted, new RegExp(sha));
  assert.match(submitted, /href="https:\/\/github.com\/owner\/repo\/commit\//);
  assert.match(submitted, /回执编号/);
  const unknown = render(task('unknown'));
  assert.match(unknown, /GitHub 提交结果待核对/);
  assert.match(unknown, /不会自动重发/);
  assert.doesNotMatch(unknown, /GitHub 已接受提交/);
  assert.match(render(task('submitting')), /正在向 GitHub 提交/);
  const failed = task('failed'); failed.githubReceipts![0].error = '<script>failed</script>';
  assert.match(render(failed), /GitHub 操作未能提交/);
  assert.match(render(failed), /&lt;script&gt;failed&lt;\/script&gt;/);
  assert.doesNotMatch(render(failed), /<script>/);
});

test('receipt links stay on HTTPS GitHub within the exact authorized repository', () => {
  for (const value of [
    'http://github.com/owner/repo/issues/12', 'https://github.com.evil.test/owner/repo/issues/12',
    'https://owner:secret@github.com/owner/repo/issues/12', 'https://github.com:8443/owner/repo/issues/12',
    'https://api.github.com/repos/owner/repo/issues/12', 'https://github.com/owner/other/issues/12',
    'https://github.com/owner/repository/issues/12', 'https://github.com/owner/repo/../other/issues/12',
    'https://github.com/owner/repo/%2f..%2fother/issues/12', 'https://github.com//owner/repo/issues/12',
    'https://github.com/owner/repo/issues/12?token=do-not-show', 'javascript:alert(1)',
  ]) assert.equal(safeGitHubLink('owner/repo', value), undefined, value);
  const comment = 'https://github.com/owner/repo/issues/12#issuecomment-123';
  assert.equal(safeGitHubLink('owner/repo', comment), comment);
  assert.equal(safeGitHubLink('owner/repo', 'https://github.com/OWNER/REPO/pull/34'), 'https://github.com/OWNER/REPO/pull/34');
  const value = task('submitted'); value.githubReceipts![0].url = 'https://github.com/owner/other/issues/12';
  assert.doesNotMatch(render(value), /href="https:\/\/github.com\/owner\/other/);
});
