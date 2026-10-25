import { useCallback, useEffect, useRef } from "react";
import { useVirtualController, VirtualControllerState } from "./VirtualController";

export function MovementSampler({
    enabled,
    sendMoveCommand,
}: {
    enabled: boolean;
    sendMoveCommand: (vector: VirtualControllerState) => Promise<void>;
}) {
    const { state, resetState } = useVirtualController();
    const stateRef = useRef(state);
    stateRef.current = state;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isActiveRef = useRef(false);
    const queueRef = useRef({
        busy: false,
        pending: null as {vector: VirtualControllerState; at: number} | null,
    });

    const trySend = useCallback((vector: VirtualControllerState) => {
        if (!enabledRef.current) {
            return;
        }
        if (queueRef.current.busy) {
            queueRef.current.pending = {vector: vector, at: performance.now()};
        } else {
            queueRef.current.busy = true;

            (async () => {
                try {
                    await sendMoveCommand(vector);
                } catch {
                    queueRef.current.pending = null;
                }
                queueRef.current.busy = false;

                if (queueRef.current.pending !== null) {
                    const next = queueRef.current.pending;
                    queueRef.current.pending = null;
                    const stop = next.vector.velocity === 0 && next.vector.angle === 0;
                    if (enabledRef.current && (stop || performance.now() - next.at < 300)) {
                        trySend(next.vector);
                    }
                }
            })();
        }
    }, [sendMoveCommand]);

    const startInterval = useCallback(() => {
        if (isActiveRef.current) {
            return;
        }
        isActiveRef.current = true;
        trySend(stateRef.current);
        intervalRef.current = setInterval(() => {
            trySend(stateRef.current);
        }, 250);
    }, [trySend]);

    const stopInterval = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        isActiveRef.current = false;
    }, []);

    useEffect(() => {
        if (enabled && (state.velocity !== 0 || state.angle !== 0)) {
            startInterval();
        } else if (isActiveRef.current) {
            stopInterval();
            trySend({ velocity: 0, angle: 0 });
        }
    }, [enabled, state, startInterval, stopInterval, trySend]);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                queueRef.current.pending = null;
                stopInterval();
                resetState();
            }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [stopInterval, resetState]);

    useEffect(() => {
        if (!enabled) {
            queueRef.current.pending = null;
            stopInterval();
            resetState();
        }
    }, [enabled, stopInterval, resetState]);

    useEffect(() => {
        return () => {
            enabledRef.current = false;
            queueRef.current.pending = null;
            stopInterval();
        };
    }, [stopInterval]);

    return null;
}
