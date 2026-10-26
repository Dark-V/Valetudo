import {DockStatusState} from "../api/RawRobotState";

export const describeDockState = (dock: DockStatusState): string => {
    const label = {
        idle: "Idle",
        drying: "Drying mops",
        cleaning: "Washing mops",
        emptying: "Emptying dustbin",
        pause: "Dock operation paused",
        error: "Dock fault",
    }[dock.value];
    const remaining = dock.metaData.dryingRemainingMinutes;
    return dock.value === "drying" && typeof remaining === "number" && Number.isInteger(remaining) && remaining > 0 ?
        `${label} — ${remaining} min remaining` : label;
};
