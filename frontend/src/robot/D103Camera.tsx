import React, {useEffect, useRef, useState} from "react";
import {Alert, Box, Button, Checkbox, FormControlLabel, Switch, Typography} from "@mui/material";
import axios from "axios";
import {Capability, valetudoAPIBaseURL, useHighResolutionManualControlStateQuery} from "../api";

const URL = `${valetudoAPIBaseURL}/robot/capabilities/${Capability.HighResolutionManualControl}/camera`;
type CameraState = {running: boolean; bright: boolean; fps: number; frameAgeMs: number | null;
    error: string | null; stopReason?: string | null; restoring?: boolean};

/** Live images only. Never falls back to a recording or displays an expired frame as live. */
export default function D103Camera(): React.ReactElement {
    const {data: manual} = useHighResolutionManualControlStateQuery();
    const [running, setRunning] = useState(false);
    const [bright, setBright] = useState(true);
    const [allowBrightManual, setAllowBrightManual] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [stats, setStats] = useState<CameraState | null>(null);
    const [image, setImage] = useState<string | null>(null);
    const [frameTime, setFrameTime] = useState(0);
    const [clock, setClock] = useState(Date.now());
    const imageURLs = useRef(new Set<string>());
    const ownsSession = useRef(false);
    const mounted = useRef(false);

    useEffect(() => {
        mounted.current = true;
        const urls = imageURLs.current;
        const timer = window.setInterval(() => setClock(Date.now()), 500);
        const stop = () => {
            setRunning(false);
            // A second page which never started a camera must not stop the
            // active viewer's stream merely by unmounting or hiding.
            if (ownsSession.current) {
                ownsSession.current = false;
                void axios.put(URL, {enabled: false}, {timeout: 30000}).catch(() => {});
            }
        };
        const visibility = () => {
            if (document.hidden) {
                stop();
            }
        };
        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("pagehide", stop);
        return () => {
            mounted.current = false;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("pagehide", stop);
            stop();
            urls.forEach(url => URLObject.revokeObjectURL(url));
            urls.clear();
        };
    }, []);

    useEffect(() => {
        if (!running) {
            return;
        }
        const controller = new AbortController();
        let cancelled = false;
        let lastSequence = "";
        let lastState = 0;
        let timer = 0;
        const tick = async () => {
            try {
                if (Date.now() - lastState > 1500) {
                    const response = await axios.get<CameraState>(URL, {signal: controller.signal, timeout: 2500});
                    if (cancelled) {
                        return;
                    }
                    setStats(response.data);
                    lastState = Date.now();
                    if (!response.data.running) {
                        setError(response.data.error ?? response.data.stopReason ?? "Camera session ended");
                        ownsSession.current = false;
                        setRunning(false);
                        return;
                    }
                }
                const response = await axios.get(`${URL}/frame.png`, {
                    responseType: "blob", timeout: 2500, signal: controller.signal,
                    params: {t: Date.now()}, validateStatus: code => code === 200 || code === 503
                });
                if (cancelled) {
                    return;
                }
                const sequence = response.headers["x-d103-sequence"];
                if (response.status === 200 && sequence !== lastSequence) {
                    const next = URLObject.createObjectURL(response.data);
                    const received = Date.now();
                    const decoded = new window.Image();
                    decoded.src = next;
                    try {
                        await decoded.decode();
                    } catch (e) {
                        URLObject.revokeObjectURL(next);
                        throw e;
                    }
                    if (cancelled) {
                        URLObject.revokeObjectURL(next);
                        return;
                    }
                    imageURLs.current.add(next);
                    setImage(next);
                    setFrameTime(received - Number(response.headers["x-d103-age-ms"] ?? 0));
                    setError("");
                    lastSequence = sequence;
                }
            } catch (e) {
                if (!cancelled) {
                    setError("Camera connection lost; stream will stop when its lease expires");
                }
            }
            if (!cancelled) {
                timer = window.setTimeout(() => {
                    void tick();
                }, 100);
            }
        };
        void tick();
        return () => {
            cancelled = true; controller.abort(); window.clearTimeout(timer);
        };
    }, [running]);

    const fresh = running && image !== null && clock - frameTime < 1800;
    return <Box sx={{mb: 2}}>
        <Box sx={{display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center"}}>
            <Button disabled={busy} variant="outlined" onClick={async () => {
                const starting = !running;
                setBusy(true); setError("");
                if (starting) {
                    ownsSession.current = true;
                }
                try {
                    const response = await axios.put<CameraState>(URL,
                        {enabled: starting, bright: bright && (!manual?.enabled || allowBrightManual),
                            allowBrightManual: allowBrightManual}, {timeout: 30000});
                    if (starting && response.data.running && (!mounted.current || document.hidden || !ownsSession.current)) {
                        ownsSession.current = false;
                        await axios.put(URL, {enabled: false}, {timeout: 30000});
                        return;
                    }
                    ownsSession.current = response.data.running;
                    setStats(response.data); setRunning(response.data.running);
                    if (response.data.error) {
                        setError(response.data.error);
                    }
                    if (response.data.running) {
                        setImage(null); setFrameTime(0);
                    }
                } catch (e) {
                    if (starting && ownsSession.current) {
                        ownsSession.current = false;
                        // An HTTP rejection may mean another viewer owns the
                        // camera. Never stop that session from this catch path;
                        // an uncertain timed-out start expires its own lease.
                    }
                    setError(axios.isAxiosError(e) && typeof e.response?.data === "string" ? e.response.data : "Camera request failed");
                } finally {
                    setBusy(false);
                }
            }}>{busy ? "Restoring / starting…" : running ? "Stop camera" : "Start camera"}</Button>
            <FormControlLabel label="Bright view" control={<Switch
                checked={bright && (!manual?.enabled || allowBrightManual)}
                disabled={running || busy || (!!manual?.enabled && !allowBrightManual)}
                onChange={(_, checked) => setBright(checked)}/>}/>
        </Box>
        <FormControlLabel label="Allow bright view while driving (experimental)" control={<Checkbox
            checked={allowBrightManual} disabled={running || busy}
            onChange={(_, checked) => setAllowBrightManual(checked)}/>}/>
        {allowBrightManual && <Alert severity="warning" sx={{mb: 1}}>
            Changes the navigation camera exposure. Obstacle detection may be affected.
            Drive attended on a level floor, away from stairs; not validated for autonomous navigation.
            Exposure is restored when the camera stops or before automatic cleaning/docking.
        </Alert>}
        <Typography variant="caption" component="p" sx={{my: 1}}>
            SC035GS · monochrome · 640×480 · stripe rejection + motion-gated denoise.
            {running && ` ${stats?.fps ?? 0} fps · ${stats?.bright ? "bright preview" : "factory navigation exposure"}`}
        </Typography>
        {manual?.enabled && !stats?.bright && <Alert severity="info" sx={{mb: 1}}>
            Factory exposure: the picture may be dark. To keep a bright view, stop the camera,
            approve the experimental bright-driving mode above, then start it again.
        </Alert>}
        {error && <Alert severity="warning" sx={{mb: 1}}>{error}</Alert>}
        <Box sx={{position: "relative", width: "100%", maxWidth: 640, aspectRatio: "4/3", bgcolor: "#000", mx: "auto"}}>
            {fresh ? <img src={image ?? undefined} alt="Live D103CN navigation camera" draggable={false}
                onLoad={e => {
                    const displayed = e.currentTarget.src;
                    // Revoke only once the replacement has actually loaded in
                    // the visible element, not before React commits its src.
                    imageURLs.current.forEach(url => {
                        if (url !== displayed) {
                            URLObject.revokeObjectURL(url);
                            imageURLs.current.delete(url);
                        }
                    });
                }}
                style={{width: "100%", height: "100%", objectFit: "contain"}}/> :
                <Typography sx={{position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ccc"}}>
                    {running ? "Waiting for a fresh frame…" : "Camera off"}
                </Typography>}
            {fresh && <Typography sx={{position: "absolute", top: 4, left: 8, bgcolor: "#000a", color: "#fff", px: 1}}>
                LIVE · {Math.max(0, clock - frameTime)} ms since update
            </Typography>}
        </Box>
    </Box>;
}

// Avoid colliding with the endpoint URL constant.
const URLObject = window.URL;
