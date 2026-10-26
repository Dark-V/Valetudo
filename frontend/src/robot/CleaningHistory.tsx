import React from "react";
import {
    Alert, Box, Button, CircularProgress, Paper, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, Typography
} from "@mui/material";
import {Capability, useCleaningHistoryQuery} from "../api";
import {useCapabilitiesSupported} from "../CapabilitiesProvider";

const PAGE_SIZE = 25;
const MODES: Record<number, string> = {
    2: "Cleaning", 18: "Rooms", 19: "Zones", 23: "Go to"
};
const CLEANING_TYPES = {
    vacuum: "Vacuum only",
    mop: "Mop only",
    vacuum_and_mop: "Vacuum + mop"
};

const HistoryPage = (): React.ReactElement => {
    const [offset, setOffset] = React.useState(0);
    const {data, isPending, isFetching, isError, refetch} = useCleaningHistoryQuery(PAGE_SIZE, offset);
    return <Box mt={3}>
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Typography variant="h6">Cleaning history</Typography>
            <Button disabled={isFetching} onClick={() => {
                void refetch();
            }}>Refresh</Button>
        </Box>
        {isPending && <CircularProgress size={24}/>}
        {isError && <Alert severity="error">Unable to read cleaning history. Retry when the robot is available.</Alert>}
        {data && <>
            {data.skippedRecords > 0 && <Alert severity="warning">{data.skippedRecords} unreadable records were skipped on this page.</Alert>}
            <TableContainer component={Paper}>
                <Table size="small" aria-label="Cleaning history">
                    <TableHead><TableRow>
                        <TableCell>Started</TableCell><TableCell>Task</TableCell><TableCell>Cleaning type</TableCell>
                        <TableCell>Cleaning time</TableCell><TableCell>Area</TableCell><TableCell>Result</TableCell>
                    </TableRow></TableHead>
                    <TableBody>{data.records.map(record => <TableRow key={record.id}>
                        <TableCell>{new Date(record.startedAt).toLocaleString()}</TableCell>
                        <TableCell>{MODES[record.nativeMode] ?? `Mode ${record.nativeMode}`}</TableCell>
                        <TableCell>{record.cleaningType ? CLEANING_TYPES[record.cleaningType] : "Unknown"}</TableCell>
                        <TableCell>{Math.round(record.duration / 60)} min</TableCell>
                        <TableCell>{(record.area / 10000).toLocaleString()} m²</TableCell>
                        <TableCell>{record.completed === true ? "Completed" : record.completed === false ? "Not completed" : "Unknown"}</TableCell>
                    </TableRow>)}</TableBody>
                </Table>
            </TableContainer>
            {data.total === 0 && <Typography mt={2}>No cleaning records stored on this robot.</Typography>}
            <Box display="flex" alignItems="center" justifyContent="space-between" mt={1}>
                <Button disabled={offset === 0 || isFetching} onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                }}>Newer</Button>
                <Typography variant="body2">{data.total} stored records</Typography>
                <Button disabled={!data.hasMore || isFetching} onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                }}>Older</Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
                Dates follow the robot’s clock at the time of cleaning. Cleaning time excludes pauses. Historical maps are not included.
                Sequential vacuum/mop runs may appear as separate records.
            </Typography>
        </>}
    </Box>;
};

const CleaningHistory = (): React.ReactElement | null => {
    const [supported] = useCapabilitiesSupported(Capability.CleaningHistory);
    return supported ? <HistoryPage/> : null;
};

export default CleaningHistory;
