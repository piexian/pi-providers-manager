/** Bound HTTP header/body idle gaps without changing the SDK's total request deadline. */
export function withIdleTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
	if (timeoutMs === 0) return fetchImpl;
	return async (input, init) => {
		const controller = new AbortController();
		const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = original ? AbortSignal.any([original, controller.signal]) : controller.signal;
		signal.throwIfAborted();
		const timeout = () => controller.abort(new DOMException(`HTTP stream idle timeout after ${timeoutMs}ms`, "TimeoutError"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
		const timed = async <T>(operation: Promise<T>): Promise<T> => {
			clear();
			timer = setTimeout(timeout, timeoutMs);
			let abort: (() => void) | undefined;
			try {
				return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
					abort = () => reject(signal.reason);
					if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
				})]);
			} finally { clear(); if (abort) signal.removeEventListener("abort", abort); }
		};
		const response = await timed(fetchImpl(input, { ...init, signal }));
		if (!response.body) return response;
		const reader = response.body.getReader();
		const stream = new ReadableStream<Uint8Array>({
			async pull(output) {
				try {
					const { done, value } = await timed(reader.read());
					if (done) { reader.releaseLock(); output.close(); }
					else output.enqueue(value);
				} catch (error) {
					void reader.cancel(error).catch(() => {});
					output.error(error);
				}
			},
			async cancel(reason) { clear(); controller.abort(reason); await reader.cancel(reason); },
		});
		return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}
