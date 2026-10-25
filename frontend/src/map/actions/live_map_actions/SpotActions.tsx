import React from "react";
import {CircularProgress, Grid2, Typography} from "@mui/material";
import {Clear as ClearIcon, MyLocation as SpotIcon} from "@mui/icons-material";
import {useLongPress} from "use-long-press";
import {useRobotStatusQuery, useSpotCleaningMutation} from "../../../api";
import {floorObject} from "../../../api/utils";
import {IterationsIcon} from "../../../assets/icon_components/IterationsIcon";
import IntegrationHelpDialog from "../../../components/IntegrationHelpDialog";
import {ActionButton} from "../../Styled";
import GoToTargetClientStructure from "../../structures/client_structures/GoToTargetClientStructure";
import {PointCoordinates} from "../../utils/types";

interface SpotActionsProperties {
    goToTarget: GoToTargetClientStructure | undefined;
    convertPixelCoordinatesToCMSpace(coordinates: PointCoordinates): PointCoordinates;
    onClear(): void;
}

const SpotActions = ({goToTarget, convertPixelCoordinatesToCMSpace, onClear}: SpotActionsProperties): React.ReactElement => {
    const [iterations, setIterations] = React.useState(1);
    const [helpOpen, setHelpOpen] = React.useState(false);
    const {data: status} = useRobotStatusQuery(state => state.value);
    const {mutate: cleanSpot, isPending} = useSpotCleaningMutation({onSuccess: onClear});
    const canClean = status === "idle" || status === "paused" || status === "docked";
    const parameters = goToTarget ? {
        coordinates: floorObject(convertPixelCoordinatesToCMSpace({x: goToTarget.x0, y: goToTarget.y0})),
        iterations: iterations
    } : undefined;
    const clickHandlers = useLongPress(() => setHelpOpen(true), {
        onCancel: () => {
            if (canClean && parameters && !isPending) {
                cleanSpot(parameters);
            }
        },
        threshold: 500, captureEvent: true, cancelOnMovement: true
    });

    return <>
        <Grid2 container spacing={1} direction="row-reverse" flexWrap="wrap-reverse">
            <Grid2>
                <ActionButton color="inherit" size="medium" variant="extended"
                    disabled={!canClean || !parameters || isPending} {...clickHandlers()}>
                    <SpotIcon sx={{mr: 0.5}}/> Spot clean
                    {isPending && <CircularProgress color="inherit" size={18} sx={{ml: 1}}/>}
                </ActionButton>
            </Grid2>
            <Grid2>
                <ActionButton color="inherit" size="medium" variant="extended" disabled={isPending}
                    onClick={() => setIterations(iterations % 4 + 1)}>
                    <IterationsIcon iterationCount={iterations}/>
                </ActionButton>
            </Grid2>
            {goToTarget && <Grid2>
                <ActionButton color="inherit" size="medium" variant="extended" onClick={onClear} disabled={isPending}>
                    <ClearIcon sx={{mr: 0.5}}/> Clear
                </ActionButton>
            </Grid2>}
            {!goToTarget && <Grid2><Typography variant="caption">Tap the map to select a spot</Typography></Grid2>}
            {!canClean && <Grid2><Typography variant="caption">Spot cleaning requires an idle, paused or docked robot</Typography></Grid2>}
        </Grid2>
        <IntegrationHelpDialog dialogOpen={helpOpen} setDialogOpen={setHelpOpen}
            helperText="Send this payload to the SpotCleaningCapability REST endpoint to clean around the selected point."
            coordinatesWarning={true} payload={JSON.stringify({action: "clean", ...parameters}, null, 2)}/>
    </>;
};

export default SpotActions;
