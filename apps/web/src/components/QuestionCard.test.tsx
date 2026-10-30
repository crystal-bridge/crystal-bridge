import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionCard } from './QuestionCard.js';

const input = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'Warm' },
        { label: 'Blue', description: 'Cool' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sizes?',
      header: 'Sizes',
      options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }],
      multiSelect: true,
    },
  ],
};

describe('QuestionCard', () => {
  afterEach(() => cleanup());

  it('shows each question with its options, and sends the chosen answers keyed by question', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard input={input} pending onAnswer={onAnswer} />);
    expect(screen.getByText('Which color do you prefer?')).toBeTruthy();
    expect(screen.getByText('Cool')).toBeTruthy();

    const submit = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'S' }));
    fireEvent.click(screen.getByRole('button', { name: 'L' }));
    fireEvent.click(submit);

    expect(onAnswer).toHaveBeenCalledWith('allow', { 'Which color do you prefer?': 'Blue', 'Which sizes?': 'S, L' });
  });

  it('accepts a typed answer instead of an option', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard input={{ questions: [input.questions[0]!] }} pending onAnswer={onAnswer} />);
    fireEvent.change(screen.getByPlaceholderText('Other…'), { target: { value: 'Green' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onAnswer).toHaveBeenCalledWith('allow', { 'Which color do you prefer?': 'Green' });
  });

  it('can skip the questions, and locks once answered', () => {
    const onAnswer = vi.fn();
    const { rerender } = render(<QuestionCard input={input} pending onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onAnswer).toHaveBeenCalledWith('deny');

    rerender(<QuestionCard input={input} pending={false} behavior="allow" onAnswer={onAnswer} />);
    expect((screen.getByRole('button', { name: /Blue/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Answered')).toBeTruthy();
  });
});
