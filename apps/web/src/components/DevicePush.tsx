/** Where this device's Web Push stands; `blocked` means the browser's notification permission was denied. */
export type PushState = 'unsupported' | 'blocked' | 'off' | 'on' | 'busy';

/**
 * Web Push for this device: notifications even with every tab closed, worded by the hub from this device's
 * Kingdom names and Full/Discreet/Off levels.
 */
export function DevicePush({
  state,
  error,
  onChange,
}: {
  state: PushState;
  error?: string;
  onChange: (on: boolean) => void;
}) {
  if (state === 'unsupported') return null;
  return (
    <div className="text-xs">
      {state === 'blocked' ? (
        <p className="text-amber-600">
          Notifications are blocked for this site. Allow them in the browser&apos;s site settings, then reload.
        </p>
      ) : (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={state === 'on'}
            disabled={state === 'busy'}
            onChange={(e) => onChange(e.target.checked)}
          />
          Push to this device
        </label>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}
