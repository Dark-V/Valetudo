import {
    Button,
    Grid2,
    LinearProgress,
    linearProgressClasses,
    styled,
    Typography,
} from "@mui/material";
import React from "react";
import {
    Capability,
    RobotAttributeClass,
    useRobotAttributeQuery,
    useRobotStatusQuery,
    useMaintenanceReminderMutation,
} from "../api";
import {useCapabilitiesSupported} from "../CapabilitiesProvider";
import {RobotMonochromeIcon} from "../components/CustomIcons";
import ControlsCard from "./ControlsCard";
import {useValetudoColorsInverse} from "../hooks/useValetudoColors";
import {describeDockState} from "./DockStateDescription";

const BatteryProgress = styled(LinearProgress)(({ theme }) => {
    return {
        marginTop: -theme.spacing(1),
        borderRadius: theme.shape.borderRadius,
        [`&.${linearProgressClasses.colorPrimary}`]: {
            backgroundColor:
                theme.palette.grey[theme.palette.mode === "light" ? 200 : 700],
        },
    };
});

const RobotStatus = (): React.ReactElement => {
    const palette = useValetudoColorsInverse();
    const [maintenanceSupported] = useCapabilitiesSupported(Capability.MaintenanceReminder);
    const {mutate: acknowledgeMaintenance, isPending: maintenancePending} = useMaintenanceReminderMutation();
    const {
        data: status,
        isPending: isStatusPending,
        isError: isStatusError,
    } = useRobotStatusQuery();
    const {
        data: batteries,
        isPending: isBatteryPending,
        isError: isBatteryError,
    } = useRobotAttributeQuery(RobotAttributeClass.BatteryState);
    const isPending = isStatusPending || isBatteryPending;
    const {data: dockStatus} = useRobotAttributeQuery(RobotAttributeClass.DockStatusState);
    const dock = dockStatus?.[0];

    const stateDetails = React.useMemo(() => {
        if (isStatusError) {
            return <Typography color="error">Error loading robot state</Typography>;
        }

        if (status === undefined) {
            return null;
        }

        return (
            <Typography variant="overline">
                {status.value}
                {status.flag !== "none" ? <> &ndash; {status.flag}</> : ""}
            </Typography>
        );
    }, [isStatusError, status]);

    const batteriesDetails = React.useMemo(() => {
        const getBatteryColor = (level: number) => {
            if (level > 60) {
                return palette.green;
            }
            if (level > 20) {
                return palette.yellow;
            }
            return palette.red;
        };

        if (isBatteryError) {
            return <Typography color="error">Error loading battery state</Typography>;
        }

        if (batteries === undefined) {
            return null;
        }

        if (batteries.length === 0) {
            return <Typography color="textSecondary">No batteries found</Typography>;
        }

        return batteries.map((battery, index) => {
            const batteryColor = getBatteryColor(battery.level);

            return (
                <Grid2 size="grow" container direction="column" key={index}>
                    <Grid2>
                        <Typography
                            variant="overline"
                            style={{
                                color: batteryColor,
                                fontWeight: 500
                            }}
                        >
                            Battery{batteries.length > 1 ? ` ${index + 1}` : ""}: {Math.round(battery.level)}%
                            {battery.flag === "charging" ? " · Charging" : battery.flag === "charged" ? " · Fully charged" : ""}
                        </Typography>
                    </Grid2>
                    <Grid2 sx={{ flexGrow: 1, minHeight: "1rem" }}>
                        <BatteryProgress
                            value={battery.level}
                            variant="determinate"
                            sx={{
                                [`& .${linearProgressClasses.bar}`]: {
                                    backgroundColor: batteryColor,
                                },
                            }}
                        />
                    </Grid2>
                </Grid2>
            );
        });
    }, [batteries, isBatteryError, palette]);

    return (
        <ControlsCard
            icon={RobotMonochromeIcon}
            title="Robot"
            isLoading={isPending}
            pending={maintenancePending}
        >
            <Grid2 size="grow" container direction="column">
                <Grid2 container direction="row">
                    <Grid2>
                        {stateDetails}
                    </Grid2>
                </Grid2>
                {dock && !["idle", "error"].includes(dock.value) && (
                    <Typography variant="body2" color="textSecondary" sx={{mb: 1}}>
                        {describeDockState(dock)}
                    </Typography>
                )}
                {status?.metaData.maintenanceReminder && (
                    <Grid2 sx={{mb: 1}}>
                        <Typography variant="body2" color="textSecondary">
                            Maintenance reminder: {status.metaData.maintenanceReminder}
                        </Typography>
                        {maintenanceSupported && <Button size="small" disabled={maintenancePending}
                            title="Confirm after cleaning the station tray"
                            onClick={() => {
                                acknowledgeMaintenance("mop_tray");
                            }}>Tray cleaned</Button>}
                    </Grid2>
                )}
                {batteries !== undefined && batteries.length > 0 && (
                    <Grid2 size="grow" container direction="row" width="100%">
                        {batteriesDetails}
                    </Grid2>
                )}
            </Grid2>
        </ControlsCard>
    );
};

export default RobotStatus;
