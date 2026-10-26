import React from "react";
import {Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography} from "@mui/material";
import {useMutation, useQuery} from "@tanstack/react-query";
import {useSnackbar} from "notistack";
import {Capability, valetudoAPI} from "../api";
import PaperContainer from "../components/PaperContainer";
import DetailPageHeaderRow from "../components/DetailPageHeaderRow";
import {Tune as TuneIcon} from "@mui/icons-material";

type Profile = {fan: "low" | "medium" | "high" | "max"; water: "low" | "medium" | "high"; iterations: number};
type Room = {id: string; name: string; profile: Profile | null};
type Profiles = {mapId: number; revision: string; rooms: Room[]};

const RoomProfiles = (): React.ReactElement => {
    const {enqueueSnackbar} = useSnackbar();
    const [draft, setDraft] = React.useState<Profiles>();
    const [modified, setModified] = React.useState(false);
    const query = useQuery({queryKey: ["room_profiles"], queryFn: async () => {
        return (await valetudoAPI.get<Profiles>(`/robot/capabilities/${Capability.RoomProfiles}`)).data;
    }, refetchOnWindowFocus: false, retry: false});
    React.useEffect(() => {
        if (query.data && !modified) {
            setDraft(structuredClone(query.data));
        }
    }, [query.data, modified]);
    const save = useMutation({mutationFn: async (value: Profiles) => {
        return (await valetudoAPI.put<Profiles>(`/robot/capabilities/${Capability.RoomProfiles}`, value)).data;
    }, onSuccess: (value) => {
        setDraft(value); setModified(false);
        query.refetch().catch(() => { /* preserve saved result */ });
        enqueueSnackbar("Room profiles saved. No cleaning started.", {variant: "success"});
    }, onError: () => enqueueSnackbar("Could not save room profiles. Refresh if the map changed.", {variant: "error"})});
    const update = (id: string, profile: Profile | null) => {
        setDraft(previous => previous ? {...previous, rooms: previous.rooms.map(room => room.id === id ? {...room, profile: profile} : room)} : previous);
        setModified(true);
    };
    return <PaperContainer>
        <DetailPageHeaderRow title="Room profiles" icon={<TuneIcon/>} isRefreshing={query.isFetching}
            onRefreshClick={() => {
                setModified(false); query.refetch().catch(() => { /* shown below */ });
            }}/>
        <Alert severity="info" sx={{mb: 2}}>
            Saved per map. Applied when cleaning selected rooms with Use room profiles enabled, including API and timer room jobs.
            Rooms without a profile use the global settings. Whole-home and zone cleaning keep their usual settings.
            Saving does not start cleaning or change the firmware map.
        </Alert>
        {query.isError && <Alert severity="error">Wait for a live map, then refresh. Existing profiles are preserved.</Alert>}
        {draft && <>
            <Typography variant="caption">Map {draft.mapId}</Typography>
            <Stack spacing={2} sx={{my: 2}}>
                {draft.rooms.map(room => <Box key={room.id} sx={{borderBottom: 1, borderColor: "divider", pb: 2}}>
                    <FormControlLabel label={`${room.name} (${room.id})`} control={<Checkbox checked={room.profile !== null}
                        disabled={save.isPending} onChange={(_, enabled) => update(room.id, enabled ? {fan: "medium", water: "medium", iterations: 1} : null)}/>}/>
                    {room.profile && <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                        <TextField select label="Fan" value={room.profile.fan} disabled={save.isPending} sx={{minWidth: 130}}
                            onChange={e => update(room.id, {...room.profile!, fan: e.target.value as Profile["fan"]})}>
                            {["low", "medium", "high", "max"].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}
                        </TextField>
                        <TextField select label="Water" value={room.profile.water} disabled={save.isPending} sx={{minWidth: 110}}
                            onChange={e => update(room.id, {...room.profile!, water: e.target.value as Profile["water"]})}>
                            {["low", "medium", "high"].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}
                        </TextField>
                        <TextField select label="Passes" value={room.profile.iterations} disabled={save.isPending} sx={{minWidth: 95}}
                            onChange={e => update(room.id, {...room.profile!, iterations: Number(e.target.value)})}>
                            {[1, 2, 3].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}
                        </TextField>
                    </Stack>}
                </Box>)}
            </Stack>
            <Button variant="outlined" disabled={!modified || save.isPending || query.isError || query.isFetching}
                loading={save.isPending} onClick={() => save.mutate(draft)}>Save profiles</Button>
        </>}
    </PaperContainer>;
};
export default RoomProfiles;
