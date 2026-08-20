import type { CSSProperties, ReactNode } from 'react';

type IconName = 'agent-farm' | 'branch' | 'chevron' | 'close' | 'filter' | 'folder' | 'folder-open' | 'moon' | 'search' | 'terminal';
export type AgentIdentityTone = 'sol' | 'luna' | 'terra' | 'review' | 'unknown';
export type AgentLifecycleTone = 'active' | 'waiting' | 'complete' | 'blocked' | 'unknown';

export function agentIdentityTone(value: string): AgentIdentityTone {
  const normalized = value.toLowerCase();
  if (normalized.includes('codex-auto-review')) return 'luna';
  if (normalized.includes('luna')) return 'luna';
  if (normalized.includes('terra')) return 'terra';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('sol')) return 'sol';
  return 'unknown';
}

export function TaskMapIcon({ name, size = 18 }: { readonly name: IconName; readonly size?: number }): ReactNode {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (name === 'agent-farm') return <svg {...common}><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" /><circle cx="12" cy="7.8" r="1.7" /><circle cx="7.9" cy="15.5" r="1.45" /><circle cx="16.1" cy="15.5" r="1.45" /><path d="M12 9.7v2.1m0 0-4.1 2.3m4.1-2.3 4.1 2.3" /></svg>;
  if (name === 'branch') return <svg {...common}><circle cx="12" cy="5" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 7v4m0 0H6v5m6-5h6v5" /></svg>;
  if (name === 'chevron') return <svg {...common}><path d="m9 5 7 7-7 7" /></svg>;
  if (name === 'close') return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  if (name === 'filter') return <svg {...common}><path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" /></svg>;
  if (name === 'folder') return <svg {...common}><path d="M3.5 6.5h6l1.8 2h9.2v9.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8Z" /><path d="M3.5 6.5v-1a1.8 1.8 0 0 1 1.8-1.8h4.1l1.8 2h5.3" /></svg>;
  if (name === 'folder-open') return <svg {...common}><path d="M3.5 7.5h6l1.8 2h9.2l-1.5 7.4a1.8 1.8 0 0 1-1.8 1.4H5.1a1.8 1.8 0 0 1-1.8-1.8Z" /><path d="M3.5 7.5v-2a1.8 1.8 0 0 1 1.8-1.8h4.1l1.8 2h5.3" /></svg>;
  if (name === 'moon') return <svg {...common}><path d="M19 15.3A8 8 0 0 1 8.7 5a7.3 7.3 0 1 0 10.3 10.3Z" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
  if (name === 'terminal') return <svg {...common}><path d="m5 7 4 5-4 5m7 0h7" /></svg>;
  return null;
}

function IdentitySymbol({ tone }: { readonly tone: AgentIdentityTone }): ReactNode {
  if (tone === 'sol') return <><circle cx="12" cy="12" r="3.25" /><path d="M12 3.2v2.3M12 18.5v2.3M3.2 12h2.3M18.5 12h2.3M5.8 5.8l1.6 1.6m9.2 9.2 1.6 1.6m0-12.4-1.6 1.6m-9.2 9.2-1.6 1.6" /></>;
  if (tone === 'luna') return <><path d="M16.8 16.9A7.2 7.2 0 0 1 8 7.2a6.7 6.7 0 1 0 8.8 9.7Z" /><path d="m17.2 5 .55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45L15.2 7l1.45-.55Z" /></>;
  if (tone === 'terra') return <><circle cx="12" cy="12" r="7.2" /><path d="M5.4 10.3h13.2M5.4 13.7h13.2M12 4.8c2 2 3 4.4 3 7.2s-1 5.2-3 7.2c-2-2-3-4.4-3-7.2s1-5.2 3-7.2Z" /></>;
  if (tone === 'review') return <><path d="M12 4.3 18.2 7v4.8c0 4-2.3 6.5-6.2 7.9-3.9-1.4-6.2-3.9-6.2-7.9V7Z" /><path d="m8.8 12 2.1 2.1 4.4-4.4" /></>;
  return <><circle cx="12" cy="6" r="1.5" /><circle cx="7" cy="16.5" r="1.5" /><circle cx="17" cy="16.5" r="1.5" /><path d="M12 7.5v3m0 0-5 4.5m5-4.5 5 4.5" /></>;
}

function LifecycleSymbol({ state }: { readonly state: AgentLifecycleTone }): ReactNode {
  if (state === 'complete') return <path d="m3.2 6 2 2 3.8-4" />;
  if (state === 'active') return <path d="m4 3 4 3-4 3Z" fill="currentColor" stroke="none" />;
  if (state === 'waiting') return <><circle cx="6" cy="6" r="4.2" /><path d="M6 3.7V6l1.7 1" /></>;
  if (state === 'blocked') return <path d="m3 3 6 6m0-6L3 9" />;
  return <path d="M6 8.8v.1M4.8 4.5A1.5 1.5 0 1 1 6.4 7v.5" />;
}

export function LifecycleBadge({ state }: { readonly state: AgentLifecycleTone }): ReactNode {
  return <span className="task-map-lifecycle-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><LifecycleSymbol state={state} /></svg></span>;
}

export function ModelGlyph({ model, size = 28, lifecycle = 'unknown' }: { readonly model: string; readonly size?: number; readonly lifecycle?: AgentLifecycleTone }): ReactNode {
  const tone = agentIdentityTone(model);
  return <span className={`task-map-model-glyph task-map-model-${tone} task-map-glyph-${lifecycle}`} style={{ '--glyph-size': `${size}px` } as CSSProperties} aria-hidden="true">
    <svg className="task-map-identity-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><IdentitySymbol tone={tone} /></svg>
    <LifecycleBadge state={lifecycle} />
  </span>;
}
