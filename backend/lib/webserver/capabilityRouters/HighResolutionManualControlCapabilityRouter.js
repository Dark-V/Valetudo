const CapabilityRouter = require("./CapabilityRouter");
const ValetudoManualMovementVector = require("../../entities/core/ValetudoManualMovementVector");

class HighResolutionManualControlCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        // Model-local extension. Other robots retain their existing manual-control routes.
        const camera = this.capability.robot.camera;
        if (camera && typeof camera.getFrame === "function") {
            this.router.get("/camera", (req, res) => {
                res.set("Cache-Control", "no-store").json(camera.state());
            });
            this.router.get("/camera/readiness", async (req, res) => {
                try {
                    await this.capability.robot.refreshControlState({noRetry: false});
                    res.set("Cache-Control", "no-store").json(this.capability.robot.getControlReadiness());
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            });
            this.router.get("/transport/readiness", async (req, res) => {
                try {
                    res.set("Cache-Control", "no-store").json(await this.capability.robot.probeManualTransport());
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            });
            this.router.put("/camera", async (req, res) => {
                if (typeof req.body?.enabled !== "boolean" ||
                    (req.body.bright !== undefined && typeof req.body.bright !== "boolean") ||
                    (req.body.allowBrightManual !== undefined && typeof req.body.allowBrightManual !== "boolean") ||
                    Object.keys(req.body).some(key => !["enabled", "bright", "allowBrightManual"].includes(key))) {
                    return res.sendStatus(400);
                }
                try {
                    if (req.body.enabled) {
                        await camera.start(req.body.bright === true, req.body.allowBrightManual === true);
                    } else {
                        await camera.stop();
                    }
                    res.set("Cache-Control", "no-store").json(camera.state());
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            });
            this.router.get("/camera/frame.png", (req, res) => {
                const frame = camera.getFrame();
                res.set({"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"});
                if (!frame) {
                    return res.sendStatus(503);
                }
                res.set({"Content-Type": "image/png", "X-D103-Sequence": String(frame.sequence),
                    "X-D103-Source-Ms": String(frame.sourceMs),
                    "X-D103-Age-Ms": String(Math.round(performance.now() - frame.at))});
                res.send(frame.png);
            });
        }
        this.router.get("/", async (req, res) => {
            try {
                res.json({
                    enabled: await this.capability.manualControlActive(),
                    ...(typeof this.capability.getDiagnostics === "function" ? this.capability.getDiagnostics() : {})
                });
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "enable":
                    try {
                        await this.capability.enableManualControl();
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;
                case "disable":
                    try {
                        await this.capability.disableManualControl();
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;
                case "move":
                    if (
                        req.body.vector !== undefined &&
                        typeof req.body.vector.velocity === "number" &&
                        typeof req.body.vector.angle === "number"
                    ) {
                        try {
                            await this.capability.manualControl(new ValetudoManualMovementVector({
                                velocity: req.body.vector.velocity,
                                angle: req.body.vector.angle
                            }));

                            res.sendStatus(200);
                        } catch (e) {
                            this.sendErrorResponse(req, res, e);
                        }
                    } else {
                        res.sendStatus(400);
                    }
                    break;
                default:
                    res.sendStatus(400);
            }
        });
    }
}

module.exports = HighResolutionManualControlCapabilityRouter;
