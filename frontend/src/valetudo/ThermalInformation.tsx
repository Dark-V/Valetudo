import React from "react";
import {Alert, Box, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography} from "@mui/material";
import {useThermalHistoryQuery} from "../api";
import ReloadableCard from "../components/ReloadableCard";

const celsius = (value: number | null): string => value === null ? "—" : `${value.toFixed(1)} °C`;

const ThermalInformation = (): React.ReactElement => {
    const {data, isPending, isFetching, isError, refetch} = useThermalHistoryQuery();
    return <ReloadableCard title="Temperature history" loading={isFetching} boxShadow={3} onReload={() => refetch()}>
        {isPending && <Skeleton height="8rem"/>}
        {isError && <Alert severity="error">Unable to read temperature history.</Alert>}
        {data && <>
            {data.sensors.length === 0 ? <Typography>No readable temperature sensors on this host.</Typography> : <TableContainer>
                <Table size="small" aria-label="Temperature history">
                    <TableHead><TableRow>
                        <TableCell>Sensor</TableCell><TableCell>Current</TableCell>
                        <TableCell>Average 1 min</TableCell><TableCell>Average 1 h</TableCell><TableCell>Average 24 h</TableCell>
                    </TableRow></TableHead>
                    <TableBody>{data.sensors.map(sensor => <TableRow key={sensor.id}>
                        <TableCell>{sensor.type}<Typography variant="caption" display="block">{sensor.id}</Typography></TableCell>
                        <TableCell>{celsius(sensor.current)}</TableCell>
                        {sensor.windows.map(window => <TableCell key={window.seconds}>
                            {celsius(window.average)}
                            <Typography variant="caption" display="block" color="text.secondary">
                                {window.complete ? `${window.samples} samples` : `Partial: ${Math.floor(window.coverageSeconds / 60)}m ${window.coverageSeconds % 60}s`}
                            </Typography>
                            <Typography variant="caption" display="block" color="text.secondary">
                                {window.samples > 0 ? `${celsius(window.min)} – ${celsius(window.max)}` : "No samples"}
                            </Typography>
                        </TableCell>)}
                    </TableRow>)}</TableBody>
                </Table>
            </TableContainer>}
            <Box mt={2}>
                <Typography variant="caption" color="text.secondary">
                    Samples every {data.sampleIntervalSeconds}s, also while this page is closed. Averages use available readings;
                    missing readings are excluded. Up to 24 hours are kept in RAM and cleared when Valetudo restarts.
                </Typography>
            </Box>
        </>}
    </ReloadableCard>;
};

export default ThermalInformation;
