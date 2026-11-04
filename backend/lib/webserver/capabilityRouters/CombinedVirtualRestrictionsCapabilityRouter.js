const CapabilityRouter = require("./CapabilityRouter");
const ValetudoRestrictedZone = require("../../entities/core/ValetudoRestrictedZone");
const ValetudoVirtualRestrictions = require("../../entities/core/ValetudoVirtualRestrictions");
const ValetudoVirtualWall = require("../../entities/core/ValetudoVirtualWall");

class CombinedVirtualRestrictionsCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.capability.getVirtualRestrictions());
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            const condition = req.get("If-Match");
            if (condition !== undefined) {
                const match = /^"(\d{1,6}):([A-Za-z0-9.-]{1,160})"$/.exec(condition);
                const robot = this.capability.robot;
                if (!match || !robot.mapEditor) {
                    return res.sendStatus(412);
                }
                try {
                    robot.mapEditor.requireRevision(robot.state.map, Number(match[1]), match[2]);
                } catch (_) {
                    return res.status(412).send("The selected floor, door, or restrictions changed. Reopen the wall preview.");
                }
            }
            if (Array.isArray(req.body.virtualWalls) && Array.isArray(req.body.restrictedZones)) {
                const virtualRestrictions = new ValetudoVirtualRestrictions({
                    virtualWalls: req.body.virtualWalls.map(requestWall => {
                        return new ValetudoVirtualWall({
                            points: {
                                pA: {
                                    x: requestWall.points.pA.x,
                                    y: requestWall.points.pA.y
                                },
                                pB: {
                                    x: requestWall.points.pB.x,
                                    y: requestWall.points.pB.y
                                }
                            }
                        });
                    }),
                    restrictedZones: req.body.restrictedZones.map(requestZone => {
                        return new ValetudoRestrictedZone({
                            points: {
                                pA: {
                                    x: requestZone.points.pA.x,
                                    y: requestZone.points.pA.y
                                },
                                pB: {
                                    x: requestZone.points.pB.x,
                                    y: requestZone.points.pB.y
                                },
                                pC: {
                                    x: requestZone.points.pC.x,
                                    y: requestZone.points.pC.y
                                },
                                pD: {
                                    x: requestZone.points.pD.x,
                                    y: requestZone.points.pD.y
                                }
                            },
                            type: requestZone.type
                        });
                    })
                });

                try {
                    await this.capability.setVirtualRestrictions(virtualRestrictions);
                    res.sendStatus(200);
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            } else {
                res.sendStatus(400);
            }
        });
    }
}

module.exports = CombinedVirtualRestrictionsCapabilityRouter;
