import { Bot } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { AgentStatusSlot } from './agent-status-slot';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { depthIndent } from './sidebar-store';

/**
 * One agent's row in the sidebar, whoever runs it: an agent this Console runs
 * and a managed agent the server places on a machine look and read the same.
 * What differs is only what goes in the slots: the marks after the provider,
 * the one warning the status slot shows, and the row's own buttons.
 */
export const SidebarAgentRow = observer(function SidebarAgentRow({
  label,
  iconUrl,
  providerId,
  isActive,
  depth,
  onOpen,
  marks,
  status,
  actions,
}: {
  label: string;
  iconUrl: string | null;
  providerId: AgentProviderId | null;
  isActive: boolean;
  depth: number;
  onOpen: () => void;
  /** Shown after the provider mark, such as where the agent runs. */
  marks: ReactNode;
  /** Indicators in order of cause; the first that renders anything is shown. */
  status: ReactNode;
  /** The row's buttons, shown on hover. */
  actions: ReactNode;
}) {
  return (
    <SidebarMenuRow
      className="group/row flex justify-between"
      data-active={isActive || undefined}
      isActive={isActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
    >
      {/* The indent lives on the content, not the row, so the hover and
          selection highlight still spans the sidebar's full width at every
          depth. */}
      <div className="flex min-w-0 flex-1 items-center gap-[9px]" style={depthIndent(depth)}>
        {/* 21px inside an 18px slot, so the larger circle reads at the same
            weight as the provider glyphs it replaced without growing the row or
            shifting the label. */}
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <AgentAvatar
            name={label}
            iconUrl={iconUrl}
            size={21}
            className="-mx-[1.5px] bg-transparent"
          />
        </span>
        <SidebarMenuAction
          aria-label={`Open agent ${label}`}
          className="flex-initial truncate select-none"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{label}</span>
            {/* What the agent runs on. The avatar took the leading slot, so
                without this the row no longer says. Hideable from the Sessions
                menu for a reader who only cares about identity. */}
            {!sidebarStore.hideProviderMark &&
              (providerId ? (
                <AgentIcon id={providerId} size={12} className="h-3 w-3 shrink-0" />
              ) : (
                <Bot className="h-3 w-3 shrink-0 text-foreground-muted" />
              ))}
            {marks}
            <AgentStatusSlot>{status}</AgentStatusSlot>
          </span>
        </SidebarMenuAction>
      </div>
      {actions}
    </SidebarMenuRow>
  );
});
