import { Component, type ReactNode } from 'react';

/** A failed lazy panel must not unmount the conversation or its unsent drafts. */
export class PanelErrorBoundary extends Component<{ children: ReactNode; onClose(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="form-stack" role="alert">
      <h3>面板暂时无法打开</h3>
      <p>可以先关闭面板继续聊天。需要再次打开时，请刷新页面后再试；刷新前请保存尚未发送的草稿。</p>
      <div className="form-actions"><button type="button" className="button button-quiet" onClick={this.props.onClose}>关闭面板</button></div>
    </div>;
  }
}
