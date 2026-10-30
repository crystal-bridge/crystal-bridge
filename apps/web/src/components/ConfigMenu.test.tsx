import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigMenu } from './ConfigMenu.js';

const visible = [
  { id: 'node-b', name: 'node-b', connected: true, sessions: 2 },
  { id: 'node-a', name: 'Lantern', connected: false, sessions: 0 },
];
const hidden = [{ id: 'secret', name: 'secret', connected: true, sessions: 1 }];

function renderMenu(overrides: Partial<Parameters<typeof ConfigMenu>[0]> = {}) {
  const props = {
    visible,
    hidden,
    onRename: vi.fn(),
    onToggleHidden: vi.fn(),
    notify: {} as Record<string, 'full' | 'discreet' | 'off'>,
    onNotify: vi.fn(),
    status: 'open',
    canNotify: 'granted',
    onEnableNotifications: vi.fn(),
    push: 'off' as const,
    onPush: vi.fn(),
    ...overrides,
  };
  render(<ConfigMenu {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Config' }));
  return props;
}

describe('ConfigMenu logging out', () => {
  afterEach(() => cleanup());

  it('logs out when the hub has a login', () => {
    const onLogOut = vi.fn();
    renderMenu({ onLogOut });
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogOut).toHaveBeenCalled();
  });

  it('has no Log out on a hub without a login page', () => {
    renderMenu();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });
});

describe('ConfigMenu', () => {
  afterEach(() => cleanup());

  it('wears the theme: titled sections, themed selects and fields', () => {
    renderMenu({ onTabStyle: vi.fn() });
    expect(screen.getByLabelText('Tab style').closest('.cb-select')).toBeTruthy();
    expect(screen.getByLabelText('Notifications for node-a').closest('.cb-select')).toBeTruthy();
    expect(screen.getByLabelText('Name for node-a').className).toContain('cb-field');
    expect(screen.getByRole('heading', { name: 'Notifications' }).className).toContain('cb-label');
  });

  it('offers a swatch per prompt colour, and marks the chosen one', () => {
    const onPromptColour = vi.fn();
    renderMenu({ promptColour: 'lavender', onPromptColour });
    expect(screen.getByRole('button', { name: 'Prompt colour: Lavender' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Prompt colour: Teal' }));
    expect(onPromptColour).toHaveBeenCalledWith('teal');
  });

  it('opens from the gear and closes again', () => {
    renderMenu();
    expect(screen.getByRole('dialog', { name: 'Config' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Config' }));
    expect(screen.queryByRole('dialog', { name: 'Config' })).toBeNull();
  });

  it('ends with the Credits, which the art licences ask to be findable in the app', () => {
    renderMenu();
    const dialog = screen.getByRole('dialog', { name: 'Config' });
    expect(within(dialog).getByText('Credits').tagName).toBe('SUMMARY');
  });

  it('lets this device rename and show or hide each Kingdom, hidden ones included', () => {
    const props = renderMenu();
    fireEvent.change(screen.getByLabelText('Name for node-a'), { target: { value: 'Node A' } });
    expect(props.onRename).toHaveBeenCalledWith('node-a', 'Node A');

    fireEvent.click(screen.getByLabelText('Show secret on this device'));
    expect(props.onToggleHidden).toHaveBeenCalledWith('secret');
    expect((screen.getByLabelText('Show node-b on this device') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Show secret on this device') as HTMLInputElement).checked).toBe(false);
  });

  it('sets each Kingdom-s notifications on this device: Full, Discreet or Off', () => {
    const props = renderMenu({ notify: { 'node-a': 'discreet' } });
    const select = screen.getByLabelText('Notifications for node-a') as HTMLSelectElement;
    expect(select.value).toBe('discreet');
    fireEvent.change(screen.getByLabelText('Notifications for node-b'), { target: { value: 'off' } });
    expect(props.onNotify).toHaveBeenCalledWith('node-b', 'off');
  });

  it('asks for notification permission when the browser has not been asked yet', () => {
    const props = renderMenu({ canNotify: 'default' });
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(props.onEnableNotifications).toHaveBeenCalled();
  });

  it('turns Web Push on for this device, and shows the hub connection', () => {
    const props = renderMenu({ status: 'connecting' });
    fireEvent.click(screen.getByLabelText('Push to this device'));
    expect(props.onPush).toHaveBeenCalledWith(true);
    expect(screen.getByText(/connecting/)).toBeTruthy();
  });

  it('picks each Kingdom-s icon and banner colour, and the tab style, for this device', () => {
    const props = renderMenu({
      looks: { 'node-a': { icon: 'castle', colour: '#3550c8' } },
      onLook: vi.fn(),
      tabStyle: 'underline',
      onTabStyle: vi.fn(),
    });
    expect(screen.queryByRole('group', { name: 'Icon for node-a' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Look for node-a' }));
    const icons = screen.getByRole('group', { name: 'Icon for node-a' });
    expect(icons.querySelector('[aria-pressed="true"]')!.getAttribute('aria-label')).toBe('Castle');
    fireEvent.click(screen.getByRole('button', { name: 'Crystal spire' }));
    expect(props.onLook).toHaveBeenCalledWith('node-a', { icon: 'spire' });
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
    expect(props.onLook).toHaveBeenCalledWith('node-a', { colour: '#8a4fd0' });

    fireEvent.change(screen.getByLabelText('Tab style'), { target: { value: 'tinted' } });
    expect(props.onTabStyle).toHaveBeenCalledWith('tinted');
  });

  it("picks each Kingdom's party leader: a Class, or a different Hero per Quest", () => {
    const props = renderMenu({
      looks: { 'node-a': { icon: 'castle', colour: '#3550c8', leader: 'paladin' } },
      onLook: vi.fn(),
      leaders: [
        { value: 'paladin', label: 'Paladin' },
        { value: 'rogue', label: 'Rogue' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look for node-a' }));
    const select = screen.getByLabelText('Party leader for node-a') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Paladin', 'Rogue', 'A different Hero per Quest']);
    fireEvent.change(select, { target: { value: 'varied' } });
    expect(props.onLook).toHaveBeenCalledWith('node-a', { leader: 'varied' });
  });
});
