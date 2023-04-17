import createReconciler, {Thenable} from 'react-reconciler';
import enqueueTask from './enque-task.js';

export const getAct = (reconciler: ReturnType<typeof createReconciler>) => {
	// we track the 'depth' of the act() calls with this counter,
	// so we can tell if any async act() calls try to run in parallel.
	let actingUpdatesScopeDepth = 0;
	let isAlreadyRendering = false;

	return (callback: () => Thenable<unknown>): Thenable<void> => {
		const previousActingUpdatesScopeDepth = actingUpdatesScopeDepth;
		actingUpdatesScopeDepth++;

		const previousIsAlreadyRendering = isAlreadyRendering;
		isAlreadyRendering = true;

		function onDone() {
			actingUpdatesScopeDepth--;
			isAlreadyRendering = previousIsAlreadyRendering;
			if (__DEV__) {
				if (actingUpdatesScopeDepth > previousActingUpdatesScopeDepth) {
					// if it's _less than_ previousActingUpdatesScopeDepth, then we can assume the 'other' one has warned
					console.error(
						'You seem to have overlapping act() calls, this is not supported. ' +
							'Be sure to await previous act() calls before making a new one. '
					);
				}
			}
		}

		const flushWork = () => {
			let didFlushWork = false;
			while (reconciler.flushPassiveEffects()) {
				didFlushWork = true;
			}

			return didFlushWork;
		};

		function flushWorkAndMicroTasks(onDone: (err?: Error) => void) {
			try {
				flushWork();
				enqueueTask(() => {
					if (flushWork()) {
						flushWorkAndMicroTasks(onDone);
					} else {
						onDone();
					}
				});
			} catch (err) {
				onDone(err as any);
			}
		}

		let result: createReconciler.Thenable<unknown>;
		try {
			result = reconciler.batchedUpdates(callback, undefined);
		} catch (error) {
			// on sync errors, we still want to 'cleanup' and decrement actingUpdatesScopeDepth
			onDone();
			throw error;
		}

		if (
			result !== null &&
			typeof result === 'object' &&
			typeof result.then === 'function'
		) {
			// setup a boolean that gets set to true only
			// once this act() call is await-ed
			let called = false;
			if (__DEV__) {
				if (typeof Promise !== 'undefined') {
					//eslint-disable-next-line no-undef
					Promise.resolve()
						.then(() => {})
						.then(() => {
							if (called === false) {
								console.error(
									'You called act(async () => ...) without await. ' +
										'This could lead to unexpected testing behaviour, interleaving multiple act ' +
										'calls and mixing their scopes. You should - await act(async () => ...);'
								);
							}
						});
				}
			}

			// in the async case, the returned thenable runs the callback, flushes
			// effects and  microtasks in a loop until flushPassiveEffects() === false,
			// and cleans up
			return {
				then(resolve, reject) {
					called = true;
					result.then(
						() => {
							if (actingUpdatesScopeDepth > 1) {
								onDone();
								resolve();
								return;
							}
							// we're about to exit the act() scope,
							// now's the time to flush tasks/effects
							flushWorkAndMicroTasks((err?: Error) => {
								onDone();
								if (err) {
									(reject as any)(err);
								} else {
									resolve();
								}
							});
						},
						(err?: Error) => {
							onDone();
							(reject as any)(err);
						}
					);
				}
			};
		} else {
			if (__DEV__) {
				if (result !== undefined) {
					console.error(
						'The callback passed to act(...) function ' +
							'must return undefined, or a Promise. You returned %s',
						result
					);
				}
			}

			// flush effects until none remain, and cleanup
			try {
				if (actingUpdatesScopeDepth === 1) {
					// we're about to exit the act() scope,
					// now's the time to flush effects
					flushWork();
				}
				onDone();
			} catch (err) {
				onDone();
				throw err;
			}

			// in the sync case, the returned thenable only warns *if* await-ed
			return {
				then(resolve) {
					if (__DEV__) {
						console.error(
							'Do not await the result of calling act(...) with sync logic, it is not a Promise.'
						);
					}
					resolve();
				}
			};
		}
	};
};
