import type { TaskRecord } from '../../shared/task-consent';
import { githubRepositorySchema, type GitHubOperationKind, type GitHubOperationState } from '../../shared/github';
import { dateTime } from '../lib/format';

const actionLabels: Record<GitHubOperationKind, string> = {
  commit: '提交代码', 'issue-create': '创建 Issue', 'issue-update': '修改 Issue', comment: '添加评论',
  'pull-request-create': '创建 PR', 'pull-request-update': '修改 PR',
};
const fieldLabels = { title: '标题', body: '正文', state: '状态', labels: '标签', assignees: '指派人' };
const receiptLabels: Record<GitHubOperationState, string> = {
  submitting: '正在向 GitHub 提交', submitted: 'GitHub 已接受提交', failed: 'GitHub 操作未能提交', unknown: 'GitHub 提交结果待核对',
};
const toolLabels: Record<string, string> = {
  create_branch: '创建分支', push_files: '提交文件', create_or_update_file: '提交文件',
  issue_write: '创建或修改 Issue', add_issue_comment: '添加评论', create_pull_request: '创建 PR', update_pull_request: '修改 PR',
};

/** Account access can cover many repositories; each receipt stays on this task's actual target. */
export function safeGitHubLink(repository: string, value: string | undefined): string | undefined {
  if (!value || value.length > 4096 || !githubRepositorySchema.safeParse(repository).success) return;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search) return;
    const path = url.pathname.split('/');
    if (path.slice(1).some(part => { const decoded = decodeURIComponent(part); return ['.', '..'].includes(decoded) || /[\/\\\u0000-\u001f\u007f]/.test(decoded); })) return;
    if (`${decodeURIComponent(path[1] ?? '')}/${decodeURIComponent(path[2] ?? '')}`.toLowerCase() !== repository.toLowerCase()) return;
    return url.href;
  } catch { /* Malformed or out-of-scope URLs remain unlinked. */ }
}

export function GitHubTaskResult({ task, timezone }: { task: TaskRecord; timezone: string }) {
  const scope = task.spec.github;
  if (!scope) return null;
  const repositoryLink = safeGitHubLink(scope.repository, `https://github.com/${scope.repository}`);
  const receipts = task.githubReceipts ?? [];
  return <section className="task-scope form-stack" aria-label="GitHub 任务范围和真实回执">
    <dl className="connector-details">
      <dt>本次任务仓库</dt><dd>{repositoryLink ? <a className="text-link" href={repositoryLink} target="_blank" rel="noreferrer">{scope.repository}</a> : scope.repository}</dd>
      <dt>本次任务动作</dt><dd>{scope.operations.map(operation => actionLabels[operation]).join('、')}</dd>
      {scope.branch && <><dt>操作分支</dt><dd><code>{scope.branch}</code></dd></>}
      {scope.baseBranch && <><dt>基准分支</dt><dd><code>{scope.baseBranch}</code></dd></>}
      {scope.issueNumbers.length > 0 && <><dt>Issue 范围</dt><dd>{scope.issueNumbers.map(value => `#${value}`).join('、')}</dd></>}
      {scope.pullRequestNumbers.length > 0 && <><dt>PR 范围</dt><dd>{scope.pullRequestNumbers.map(value => `#${value}`).join('、')}</dd></>}
      {scope.issueFields.length > 0 && <><dt>允许修改的 Issue 字段</dt><dd>{scope.issueFields.map(value => fieldLabels[value]).join('、')}</dd></>}
      {scope.pullRequestFields.length > 0 && <><dt>允许修改的 PR 字段</dt><dd>{scope.pullRequestFields.map(value => fieldLabels[value]).join('、')}</dd></>}
    </dl>
    {scope.files.length > 0 ? <div><p className="field-note">本次处理的文件</p><ul className="scope-files">{scope.files.map(file => <li key={file}><code>{file}</code></li>)}</ul></div>
      : scope.accountId !== undefined && scope.operations.includes('commit') ? <p className="field-note">按任务目标处理本次仓库/分支中的文件</p> : null}
    {receipts.length > 0 ? <ul className="connector-list" aria-label="GitHub 实际提交记录">
      {receipts.map(receipt => {
        const url = safeGitHubLink(scope.repository, receipt.url);
        const sha = receipt.sha && /^[a-f0-9]{40,64}$/i.test(receipt.sha) ? receipt.sha : undefined;
        return <li className="connector-record" key={receipt.operationId}>
          <p className={`inline-result${receipt.state === 'submitted' ? ' success' : receipt.state === 'failed' || receipt.state === 'unknown' ? ' failure' : ''}`} role="status">
            {toolLabels[receipt.tool] ?? 'GitHub 操作'} · {receiptLabels[receipt.state]} · {dateTime(receipt.updatedAt, timezone, true)}
          </p>
          {(sha || receipt.number !== undefined) && <dl className="connector-details">
            {sha && <><dt>提交 SHA</dt><dd><code>{sha}</code></dd></>}
            {receipt.number !== undefined && <><dt>回执编号</dt><dd>#{receipt.number}</dd></>}
          </dl>}
          {url && <a className="text-link" href={url} target="_blank" rel="noreferrer">在 GitHub 查看实际结果</a>}
          {receipt.error && <p className="field-error">{receipt.error}</p>}
          {receipt.state === 'unknown' && <p className="field-note">提交结果尚未确定，不会自动重发。请先在原仓库核对实际结果。</p>}
        </li>;
      })}
    </ul> : <p className="field-note" role="status">尚未取得 GitHub 的真实提交回执。</p>}
  </section>;
}
