import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentPet } from './agent-pet';

describe('AgentPet', () => {
  it('selects the observed model family and maps active work to the processing row', () => {
    render(<AgentPet model="gpt-5.6-terra" lifecycle="active" activity="working" effort="high" />);
    const pet = document.querySelector('[data-pet-family="terra"]');
    expect(pet).toHaveAttribute('data-pet-state', 'working');
    expect(pet).toHaveAttribute('data-pet-effort', 'high');
  });

  it('uses review motion for an active reviewer', () => {
    render(<AgentPet model="gpt-5.6-sol" lifecycle="active" role="Evidence reviewer" effort="max" />);
    expect(document.querySelector('[data-pet-family="sol"]')).toHaveAttribute('data-pet-state', 'review');
  });

  it('marks identity mismatches without changing the observed pet family', () => {
    render(<AgentPet model="gpt-5.6-luna" lifecycle="waiting" verification="mismatch" />);
    expect(document.querySelector('[data-pet-family="luna"]')).toHaveClass('task-map-pet-mismatch');
  });

  it('falls back to the deterministic model glyph for unknown models', () => {
    render(<AgentPet model="unreported-model" lifecycle="unknown" />);
    expect(document.querySelector('.task-map-model-unknown')).not.toBeNull();
    expect(document.querySelector('.task-map-agent-pet')).toBeNull();
  });

  it('settles an already-completed agent instead of waving forever', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<AgentPet model="gpt-5.6-sol" lifecycle="complete" />);
    expect(document.querySelector('[data-pet-family="sol"]')).toHaveAttribute('data-pet-state', 'idle');
    vi.unstubAllGlobals();
  });
});
