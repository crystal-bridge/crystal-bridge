export interface PermissionCardProps {
  toolName: string;
  input: unknown;
  pending: boolean;
  behavior?: 'allow' | 'deny' | undefined;
  onAnswer: (behavior: 'allow' | 'deny') => void;
}

export function PermissionCard({ toolName, input, pending, behavior, onAnswer }: PermissionCardProps) {
  const button = 'rounded px-3 py-1 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="cb-window p-3">
      <div className="mb-2 text-sm">
        <span className="text-gold-bright">Permission requested: </span>
        <span className="font-mono font-semibold">{toolName}</span>
      </div>
      <pre className="mb-3 overflow-x-auto rounded bg-black/30 p-2 text-xs text-white">
        {JSON.stringify(input, null, 2)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${button} bg-green-600 hover:enabled:bg-green-700`}
          disabled={!pending}
          onClick={() => onAnswer('allow')}
        >
          Approve
        </button>
        <button
          type="button"
          className={`${button} bg-red-600 hover:enabled:bg-red-700`}
          disabled={!pending}
          onClick={() => onAnswer('deny')}
        >
          Deny
        </button>
        {behavior && <span className="text-sm text-white/75">{behavior === 'allow' ? 'Approved' : 'Denied'}</span>}
      </div>
    </div>
  );
}
