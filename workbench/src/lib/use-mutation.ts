import { useRef, useState } from "react";
import { ApiError } from "../api";
import { IntentKeys } from "./intent-keys";

export interface MutationState<R> {
  pending: boolean;
  error: string | null;
  /** A 409: the view was stale — surfaced as a notice, and onChanged refetches. */
  conflict: boolean;
}

/**
 * Mutations over the gateway. One idempotency key per user intent (IntentKeys):
 * reused across retries after failure, rotated on success/reset. A 409 is a
 * stale-view conflict — refetch, never pretend success.
 */
export function useMutation<A, R>(
  fn: (args: A, idempotencyKey: string) => Promise<R>,
  onChanged: () => void,
): MutationState<R> & { run: (args: A) => Promise<R | null>; reset: () => void } {
  const [state, setState] = useState<MutationState<R>>({ pending: false, error: null, conflict: false });
  const keysRef = useRef<IntentKeys | null>(null);
  if (keysRef.current === null) keysRef.current = new IntentKeys();
  const keys = keysRef.current;

  const run = async (args: A): Promise<R | null> => {
    const key = keys.begin();
    if (key === null) return null; // already in flight
    setState({ pending: true, error: null, conflict: false });
    try {
      const result = await fn(args, key);
      keys.settle();
      setState({ pending: false, error: null, conflict: false });
      onChanged();
      return result;
    } catch (err) {
      keys.fail();
      if (err instanceof ApiError && err.status === 409) {
        setState({ pending: false, error: null, conflict: true });
        onChanged();
      } else {
        setState({ pending: false, error: err instanceof Error ? err.message : String(err), conflict: false });
      }
      return null;
    }
  };

  const reset = (): void => {
    keys.reset();
    setState({ pending: false, error: null, conflict: false });
  };
  return { ...state, run, reset };
}
