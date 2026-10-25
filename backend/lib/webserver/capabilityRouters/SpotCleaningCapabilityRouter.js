const CapabilityRouter = require("./CapabilityRouter");

class SpotCleaningCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.put("/", this.validator, async (req, res) => {
            const point = req.body.coordinates;
            const iterations = req.body.iterations ?? 1;
            if (req.body.action !== "clean" || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
                !Number.isInteger(iterations) || iterations < 1 || iterations > 4) {
                res.sendStatus(400);
                return;
            }
            try {
                await this.capability.start({coordinates: {x: point.x, y: point.y}, iterations: iterations});
                res.sendStatus(200);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = SpotCleaningCapabilityRouter;
