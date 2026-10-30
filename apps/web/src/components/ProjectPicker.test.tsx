import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPicker } from './ProjectPicker.js';

const projects = [
  { path: '/home/me/code/crystal-bridge', name: 'crystal-bridge', lastUsed: 2 },
  { path: '/home/me/code/bramble', name: 'bramble', lastUsed: 1 },
  { path: '/home/me/code/jobscout', name: 'jobscout' },
];

describe('ProjectPicker', () => {
  afterEach(() => cleanup());

  it('lists the node-s projects and picks one by click', () => {
    const onChange = vi.fn();
    render(<ProjectPicker projects={projects} value="" onChange={onChange} />);
    fireEvent.focus(screen.getByLabelText('Project'));
    fireEvent.click(screen.getByRole('option', { name: /bramble/ }));
    expect(onChange).toHaveBeenCalledWith('/home/me/code/bramble');
  });

  it('filters by name or path as you type, and still accepts a path of your own', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ProjectPicker projects={projects} value="" onChange={onChange} />);
    const box = screen.getByLabelText('Project');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'job' } });
    expect(onChange).toHaveBeenLastCalledWith('job');
    rerender(<ProjectPicker projects={projects} value="job" onChange={onChange} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('jobscout')]);

    rerender(<ProjectPicker projects={projects} value="/tmp/scratch" onChange={onChange} />);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('picks the highlighted project with the keyboard', () => {
    const onChange = vi.fn();
    render(<ProjectPicker projects={projects} value="" onChange={onChange} />);
    const box = screen.getByLabelText('Project');
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('/home/me/code/bramble');
  });
});
