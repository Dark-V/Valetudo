const D103 = require("./D103CNProtocol");
const DreameMapParser = require("./DreameMapParser");
const {PathMapEntity} = require("../../entities/map");

/** Decode actual SDK frames without combining unrelated coordinate systems. */
class D103CNMapDecoder {
    /**
     * @param {Buffer} raw
     * @returns {Promise<import("../../entities/map/ValetudoMap")|null>}
     */
    static async PARSE(raw) {
        const width = raw.readInt16LE(19);
        const height = raw.readInt16LE(21);
        let extra = {};
        try {
            extra = JSON.parse(raw.subarray(27 + width * height).toString("utf8"));
        } catch (_) {
            // Keep the upstream parser's normal malformed-metadata handling.
        }
        if ((extra.ris === 1 && extra.iscleanlog !== true) || [5, 6].includes(extra.suw)) {
            // An isolated room can be scanned/cleaned without localization on
            // the saved floor. Keep its actual live geometry and relative pose.
            const localExtra = {...extra, rism: undefined};
            const local = await DreameMapParser.PARSE(Buffer.concat([
                raw.subarray(0, 27 + width * height), Buffer.from(JSON.stringify(localExtra))
            ]));
            if (local) {
                delete local.metaData.vendorMapId;
                local.metaData = {...local.metaData, source: "D103CN local SDK scan; not aligned with saved map",
                    unlocalizedScan: true, livePoseAvailable: true, relocalizationRequired: true,
                    nativeSavedMapStatus: 1};
            }
            return local;
        }
        if (extra.ris === 1 && typeof extra.rism === "string") {
            // ris=1 says the saved map is not applied to the current scan.
            // This firmware also sets iscleanlog on these live FDS frames.
            // Upstream's vSLAM history exception would overlay both origins.
            const saved = await DreameMapParser.PARSE(D103.decodeMapEnvelope(extra.rism), "rism");
            if (!saved) {
                throw new Error("Unaligned SDK frame has no usable saved map");
            }
            saved.entities = saved.entities.filter(e => e.type !== "robot_position" && !(e instanceof PathMapEntity));
            const mapId = typeof extra.curid === "string" && /^\d+$/.test(extra.curid) ? extra.curid : undefined;
            saved.metaData = {...saved.metaData, source: "D103CN saved SDK map; robot not localized",
                savedMapSnapshot: true, livePoseAvailable: false, relocalizationRequired: true,
                nativeSavedMapStatus: 1, ...(mapId ? {mapId: mapId, vendorMapId: Number(mapId)} : {})};
            return saved;
        }
        return DreameMapParser.PARSE(raw);
    }
}

module.exports = D103CNMapDecoder;
