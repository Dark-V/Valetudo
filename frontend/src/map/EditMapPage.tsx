import {Alert, Box, Button, CircularProgress, styled, Typography, useTheme} from "@mui/material";
import {useSearchParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {
    Capability,
    RawMapEntityType,
    RawMapLayer,
    useRobotMapQuery,
    useRobotStatusQuery,
    valetudoAPI
} from "../api";
import {preprocessMap} from "../api/mapUtils";
import {useCapabilitiesSupported} from "../CapabilitiesProvider";
import EditMap, { mode } from "./EditMap";
import {SegmentEditHelp} from "./res/SegmentEditHelp";
import {VirtualRestrictionEditHelp} from "./res/VirtualRestrictionEditHelp";
import {useSnackbar} from "notistack";
import React from "react";
import {MapAnnotationsHelp} from "./res/MapAnnotationsHelp";


const Container = styled(Box)({
    flex: "1",
    height: "100%",
    display: "flex",
    flexFlow: "column",
    justifyContent: "center",
    alignItems: "center",
});

const EditMapPage = (props: {
    mode: mode;
}): React.ReactElement => {
    const {
        data: mapData,
        isPending: mapIsPending,
        isError: mapLoadError,
        refetch: refetchMap
    } = useRobotMapQuery();
    const tag = mapData?.metaData.mapEditor;
    const needsNativeGeometry = (tag?.editedCells ?? 0) > 0;
    const native = useQuery({
        queryKey: ["native_map_edit_layers", tag?.floorId, tag?.revision],
        enabled: needsNativeGeometry, retry: false, staleTime: Infinity, gcTime: 0,
        queryFn: async () => {
            const {data} = await valetudoAPI.get<{floorId: number; revision: string; layers: RawMapLayer[]}>(
                "/robot/state/map/editor/native"
            );
            if (!mapData || !tag || data.floorId !== tag.floorId || data.revision !== tag.revision) {
                throw new Error("Map changed while loading firmware geometry");
            }
            return preprocessMap({...mapData, layers: data.layers}).layers;
        }
    });
    const {
        data: robotStatus,
        isPending: robotStatusPending
    } = useRobotStatusQuery();

    const [
        combinedVirtualRestrictionsCapabilitySupported,

        mapSegmentEditCapabilitySupported,
        mapSegmentRenameCapabilitySupported,
        mapSegmentMaterialControlCapabilitySupported,

        mapAnnotationsCapabilitySupported,
    ] = useCapabilitiesSupported(
        Capability.CombinedVirtualRestrictions,

        Capability.MapSegmentEdit,
        Capability.MapSegmentRename,
        Capability.MapSegmentMaterialControl,

        Capability.MapAnnotations
    );

    const theme = useTheme();
    const {enqueueSnackbar} = useSnackbar();
    const [params] = useSearchParams();

    let helpText = "";

    if (props.mode === "segments") {
        helpText = SegmentEditHelp;
    } else if (props.mode === "virtual_restrictions") {
        helpText = VirtualRestrictionEditHelp;
    } else if (props.mode === "annotations") {
        helpText = MapAnnotationsHelp;
    }

    if (mapLoadError || (needsNativeGeometry && native.isError)) {
        return (
            <Container>
                <Typography color="error">{needsNativeGeometry ? "Could not load matching firmware room boundaries for this floor." :
                    "Error loading map data"}</Typography>
                <Box m={1}/>
                <Button color="primary" variant="contained" onClick={() => {
                    void refetchMap();
                    if (needsNativeGeometry) {
                        void native.refetch();
                    }
                }}>
                    Retry
                </Button>
            </Container>
        );
    }

    if ((!mapData && mapIsPending) || (!robotStatus && robotStatusPending) || (needsNativeGeometry && !native.data)) {
        return (
            <Container>
                <CircularProgress/>
            </Container>
        );
    }

    if (!mapData) {
        return (
            <Container>
                <Typography align="center">No map data</Typography>;
            </Container>
        );
    }

    if (!robotStatus) {
        return (
            <Container>
                <Typography align="center">No robot status</Typography>;
            </Container>
        );
    }

    const doorId = props.mode === "virtual_restrictions" ? params.get("door") : null;
    let wallPoints: number[] | undefined;
    let previewKey = String(props.mode);
    if (doorId !== null) {
        const floor = mapData.metaData.mapEditor?.floorId;
        const door = mapData.entities.find(entity => entity.type === RawMapEntityType.Door &&
            entity.metaData.source === "user" && entity.metaData.id === doorId);
        if (floor === undefined || params.get("floor") !== String(floor) || door?.points.length !== 4) {
            return <Alert severity="warning">This manual door is unavailable on the current floor. Reopen it in the pixel and door editor.</Alert>;
        }
        wallPoints = door.points;
        // Recreate the draft when the firmware restrictions or the selected door change.
        const restrictions = mapData.entities.filter(entity => entity.type === RawMapEntityType.VirtualWall ||
            entity.type === RawMapEntityType.NoGoArea || entity.type === RawMapEntityType.NoMopArea);
        previewKey = JSON.stringify([floor, doorId, wallPoints, restrictions.map(entity => [entity.type, entity.points])]);
    }
    const editor = <EditMap
        key={previewKey}
        doorWallPreview={wallPoints}
        rawMap={needsNativeGeometry && native.data ? {...mapData, layers: native.data} : mapData}
        paletteMode={theme.palette.mode}
        mode={props.mode}
        helpText={helpText}
        robotStatus={robotStatus}
        enqueueSnackbar={enqueueSnackbar}

        supportedCapabilities={{
            [Capability.CombinedVirtualRestrictions]: combinedVirtualRestrictionsCapabilitySupported,

            [Capability.MapSegmentEdit]: mapSegmentEditCapabilitySupported,
            [Capability.MapSegmentRename]: mapSegmentRenameCapabilitySupported,
            [Capability.MapSegmentMaterialControl]: mapSegmentMaterialControlCapabilitySupported,
            [Capability.MapAnnotations]: mapAnnotationsCapabilitySupported
        }}
    />;
    return <>
        {needsNativeGeometry && <Alert severity="info">This tool edits navigation settings and shows the original firmware room boundaries.</Alert>}
        {wallPoints && <Alert severity="info">Navigation wall preview. Save while docked to block this passage on the robot. Manage the saved wall here independently of the door marker.</Alert>}
        {editor}
    </>;
};

export default EditMapPage;
