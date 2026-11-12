// A minimal request/response layer over postMessage, shared by the on-device scanning workers.

export interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}
export type RpcReply = { id: number; value: unknown } | { id: number; error: string } | { event: unknown };

type Handlers = Record<string, (...args: never[]) => unknown>;

const transferables = (value: unknown): Transferable[] => {
  if (ArrayBuffer.isView(value)) return [value.buffer as ArrayBuffer];
  if (value instanceof ArrayBuffer) return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(transferables);
  return [];
};

/** Worker side: answer calls with the given handlers. */
export function serve(handlers: Handlers) {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage = async (ev: MessageEvent<RpcRequest>) => {
    const { id, method, args } = ev.data;
    try {
      const value = await (handlers[method] as (...a: unknown[]) => unknown)(...args);
      scope.postMessage({ id, value } satisfies RpcReply, [...new Set(transferables(value))]);
    } catch (e) {
      scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies RpcReply);
    }
  };
}

/** Worker side: send something that is not an answer (progress). */
export function emit(event: unknown) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ event } satisfies RpcReply);
}

/** Page side: call a worker and await its answer. */
export class RpcClient {
  private next = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private dead: Error | null = null;

  constructor(
    private worker: Worker,
    onEvent: (event: unknown) => void,
    crashMessage: string,
  ) {
    worker.onmessage = (ev: MessageEvent<RpcReply>) => {
      const m = ev.data;
      if ('event' in m) return onEvent(m.event);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if ('error' in m) p.reject(new Error(m.error));
      else p.resolve(m.value);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(new Error(e.message ? `${crashMessage} (${e.message})` : crashMessage));
    };
  }

  private fail(error: Error) {
    this.dead = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  /** The worker stopped or failed for good. */
  get crashed(): boolean {
    return this.dead !== null;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args } satisfies RpcRequest, [...new Set(args.flatMap(transferables))]);
    });
  }

  terminate() {
    this.worker.terminate();
    this.fail(new Error('stopped'));
  }
}
