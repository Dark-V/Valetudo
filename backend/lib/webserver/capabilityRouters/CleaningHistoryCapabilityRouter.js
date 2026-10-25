const CapabilityRouter = require("./CapabilityRouter");

class CleaningHistoryCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            const limit = Number(req.query.limit ?? 50);
            const offset = Number(req.query.offset ?? 0);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
                res.status(400).send("Invalid history page: limit 1..100, offset 0..100000");
                return;
            }
            try {
                res.json(await this.capability.getHistory({limit: limit, offset: offset}));
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = CleaningHistoryCapabilityRouter;
