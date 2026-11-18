import type { RuntimeView } from '../../shared/runtime-view';
import type { Perform } from '../api';
import type { ConnectorOAuthResult } from '../lib/connector-oauth';
import type { Panel } from '../state/ui-state';

export interface PanelContext {
  runtime: RuntimeView;
  perform: Perform;
  busy: readonly string[];
  onOpenPanel: (panel: Panel) => void;
  onClose: () => void;
  onSelectCase: (id: string | null) => void;
  onPanelSubmitted: (id: string) => void;
}

export interface PanelContentProps extends PanelContext {
  panel: Panel;
  currentCaseId?: string | null;
  connectorOAuthResult?: ConnectorOAuthResult;
}
