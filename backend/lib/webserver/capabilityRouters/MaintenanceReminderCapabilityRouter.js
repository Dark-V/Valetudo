const CapabilityRouter = require("./CapabilityRouter");

class MaintenanceReminderCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.put("/", this.validator, async (req, res) => {
            if (req.body.action !== "acknowledge" || req.body.reminder !== "mop_tray") {
                res.sendStatus(400);
                return;
            }
            try {
                await this.capability.acknowledge(req.body.reminder);
                res.sendStatus(200);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = MaintenanceReminderCapabilityRouter;
