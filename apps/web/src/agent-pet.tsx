import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { agentIdentityTone, LifecycleBadge, ModelGlyph, type AgentLifecycleTone } from './task-map-icons';

type PetFamily = 'sol' | 'terra' | 'luna';
type PetState = 'idle' | 'working' | 'waiting' | 'review' | 'complete' | 'failed';

interface AgentPetProps {
  readonly model: string;
  readonly lifecycle: AgentLifecycleTone;
  readonly activity?: string | undefined;
  readonly role?: string | undefined;
  readonly effort?: string | undefined;
  readonly verification?: 'verified' | 'unverified' | 'mismatch' | 'unknown' | undefined;
  readonly size?: number;
}

const rows = {
  idle: { row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320] },
  complete: { row: 3, frames: 4, durations: [140, 140, 140, 280] },
  failed: { row: 5, frames: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frames: 6, durations: [150, 150, 150, 150, 150, 260] },
  working: { row: 7, frames: 6, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frames: 6, durations: [150, 150, 150, 150, 150, 280] },
} as const;

function petFamily(model: string): PetFamily | null {
  const tone = agentIdentityTone(model);
  return tone === 'sol' || tone === 'terra' || tone === 'luna' ? tone : null;
}

function effortRate(effort: string | undefined): number {
  switch (effort?.trim().toLowerCase().replaceAll('-', '')) {
    case 'low': return 0.72;
    case 'medium': return 0.9;
    case 'high': return 1.08;
    case 'xhigh':
    case 'xhighreasoning': return 1.24;
    case 'max': return 1.42;
    case 'ultra': return 1.58;
    default: return 1;
  }
}

function stableState(lifecycle: AgentLifecycleTone, activity: string | undefined, role: string | undefined): PetState {
  if (lifecycle === 'blocked') return 'failed';
  if (lifecycle === 'waiting') return 'waiting';
  if (lifecycle === 'complete') return 'idle';
  if (lifecycle !== 'active') return 'idle';
  if (/review/i.test(role ?? '')) return 'review';
  if (activity === 'waiting') return 'waiting';
  return 'working';
}

export function AgentPet({ model, lifecycle, activity, role, effort, verification, size = 38 }: AgentPetProps): ReactNode {
  const family = petFamily(model);
  const [frame, setFrame] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const previousLifecycle = useRef<AgentLifecycleTone | null>(null);

  useEffect(() => {
    const media = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = (): void => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (previousLifecycle.current !== null && previousLifecycle.current !== 'complete' && lifecycle === 'complete' && !reducedMotion) setCelebrating(true);
    previousLifecycle.current = lifecycle;
  }, [lifecycle, reducedMotion]);

  const state = celebrating ? 'complete' : stableState(lifecycle, activity, role);
  const sequence = rows[state];
  const rate = state === 'working' || state === 'review' ? effortRate(effort) : 1;

  useEffect(() => {
    setFrame(0);
  }, [state, family]);

  useEffect(() => {
    if (!family || reducedMotion) return undefined;
    const delay = Math.max(55, Math.round((sequence.durations[frame] ?? 160) / rate));
    const timer = globalThis.setTimeout(() => {
      const next = frame + 1;
      if (state === 'complete' && next >= sequence.frames) {
        setCelebrating(false);
        setFrame(0);
      } else {
        setFrame(next % sequence.frames);
      }
    }, delay);
    return () => globalThis.clearTimeout(timer);
  }, [family, frame, rate, reducedMotion, sequence, state]);

  const style = useMemo(() => ({
    '--glyph-size': `${size}px`,
    '--pet-image': `url(/pets/${family ?? 'unknown'}/spritesheet.webp)`,
    '--pet-column': `${frame}`,
    '--pet-row': `${sequence.row}`,
  }) as CSSProperties, [family, frame, sequence.row, size]);

  if (!family) return <ModelGlyph model={model} size={size} lifecycle={lifecycle} />;
  return <span
    className={`task-map-model-glyph task-map-agent-pet task-map-model-${family} task-map-glyph-${lifecycle} task-map-pet-${state} task-map-pet-effort-${effort?.toLowerCase() ?? 'unknown'} ${verification === 'mismatch' ? 'task-map-pet-mismatch' : ''}`}
    style={style}
    data-pet-family={family}
    data-pet-state={state}
    data-pet-effort={effort ?? 'unknown'}
    aria-hidden="true"
  >
    <span className="task-map-agent-pet-frame" />
    <LifecycleBadge state={lifecycle} />
  </span>;
}
