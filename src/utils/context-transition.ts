interface ContextTransitionState {
  tail: Promise<void>;
  version: number;
}

const transitionStates = new WeakMap<object, ContextTransitionState>();

export async function withContextTransition<T>(
  context: object,
  operation: () => Promise<T>,
): Promise<T> {
  const state = getState(context);
  const previous = state.tail;
  let release: (() => void) | undefined;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

export function getContextVersion(context: object): number {
  return getState(context).version;
}

export function advanceContextVersion(context: object): number {
  const state = getState(context);
  state.version += 1;
  return state.version;
}

function getState(context: object): ContextTransitionState {
  const existing = transitionStates.get(context);
  if (existing) return existing;

  const created: ContextTransitionState = {
    tail: Promise.resolve(),
    version: 0,
  };
  transitionStates.set(context, created);
  return created;
}
