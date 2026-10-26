const CapabilityRouter = require("./CapabilityRouter");

class RoomProfilesCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/preview", async (req, res) => {
            try {
                res.json(await this.capability.preview());
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.capability.getProfiles());
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
        this.router.put("/", this.validator, async (req, res) => {
            try {
                res.json(await this.capability.setProfiles(req.body));
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}
module.exports = RoomProfilesCapabilityRouter;
