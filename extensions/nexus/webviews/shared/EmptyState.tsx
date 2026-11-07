import { Button } from "./Button";

export interface EmptyStateProps {
  /** One line, no more. */
  message: string;
  action?: { label: string; onClick: () => void; kbd?: string };
}

export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div className="nx-empty">
      <span className="nx-empty-message">{message}</span>
      {action ? (
        <Button variant="primary" kbd={action.kbd} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
