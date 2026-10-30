import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptBox } from './PromptBox.js';
import { ThemedSelect } from './ThemedSelect.js';

function box(props: Partial<Parameters<typeof PromptBox>[0]> = {}) {
  const onStop = vi.fn();
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <PromptBox label="Follow-up" value="" onChange={() => {}} running={false} onStop={onStop} {...props} />
    </form>,
  );
  return { onStop, onSubmit, button: () => screen.getByRole('button', { name: /Send|Stop|Run/ }) as HTMLButtonElement };
}

describe('PromptBox', () => {
  afterEach(() => cleanup());

  it('is Stop while a turn runs and the box is empty', () => {
    const { onStop, onSubmit, button } = box({ running: true });
    expect(button().getAttribute('aria-label')).toBe('Stop');
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is Send once there is text, even while a turn runs (the follow-up queues)', () => {
    const { onStop, onSubmit, button } = box({ running: true, value: 'and then' });
    expect(button().getAttribute('aria-label')).toBe('Send');
    fireEvent.click(button());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('is a disabled Send when nothing runs and the box is empty', () => {
    const { button } = box();
    expect(button().getAttribute('aria-label')).toBe('Send');
    expect(button().disabled).toBe(true);
  });

  it('is Run for a shell command', () => {
    const { button } = box({ value: '! ls', shell: true });
    expect(button().getAttribute('aria-label')).toBe('Run');
  });

  it('starts one line tall and shows the controls under the box', () => {
    box({ controls: <span>mode here</span> });
    expect((screen.getByLabelText('Follow-up') as HTMLTextAreaElement).rows).toBe(1);
    expect(screen.getByText('mode here')).toBeTruthy();
  });
});

describe('PromptBox attachments', () => {
  afterEach(() => cleanup());

  it('adds picked or pasted files as chips that can be removed, and lets a prompt of only files send', () => {
    const onFiles = vi.fn();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    const { button } = box({ files: { list: [shot], onChange: onFiles } });
    expect(screen.getByText('shot.png')).toBeTruthy();
    expect(button().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(onFiles).toHaveBeenLastCalledWith([]);

    const notes = new File(['y'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [notes] } });
    expect(onFiles).toHaveBeenLastCalledWith([shot, notes]);

    const pasted = new File(['z'], 'image.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Follow-up'), { clipboardData: { files: [pasted] } });
    expect(onFiles).toHaveBeenLastCalledWith([shot, pasted]);
  });
});

describe('ThemedSelect', () => {
  afterEach(() => cleanup());

  it("shows the chosen option's label on its face and keeps the native select for picking", () => {
    const onChange = vi.fn();
    render(
      <ThemedSelect
        label="Permission mode"
        icon="mode"
        value="auto"
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'plan', label: 'Plan' },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Auto', { selector: '.cb-select-value' })).toBeTruthy();
    const select = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'plan' } });
    expect(onChange).toHaveBeenCalledWith('plan');
  });
});
