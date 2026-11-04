import MapStructure from "./MapStructure";
import {Canvas2DContextTrackingWrapper} from "../../utils/Canvas2DContextTrackingWrapper";
import {considerHiDPI} from "../../utils/helpers";
import {PointCoordinates} from "../../utils/types";
import {StructureInterceptionHandlerResult} from "../Structure";
import {RawMapEntityMetaData} from "../../../api/RawMapData";

/** Native detected opening, with map clearance kept separate from door position. */
class DoorMapStructure extends MapStructure {
    public static readonly TYPE = "DoorMapStructure";

    constructor(x0: number, y0: number, private x1: number, private y1: number,
                private metadata: RawMapEntityMetaData) {
        super(x0, y0);
    }

    draw(ctxWrapper: Canvas2DContextTrackingWrapper, matrix: DOMMatrixInit, scaleFactor: number): void {
        const ctx = ctxWrapper.getContext();
        const a = new DOMPoint(this.x0, this.y0).matrixTransform(matrix);
        const b = new DOMPoint(this.x1, this.y1).matrixTransform(matrix);
        const state = this.metadata.mapPassability ?? "unknown";
        const color = state === "clear" ? "#53d68a" : state === "blocked" ? "#ff6868" : "#f0be50";
        const dx = b.x-a.x, dy = b.y-a.y, length = Math.hypot(dx, dy);
        if (length < 1) {
            return;
        }
        const nx = -dy/length, ny = dx/length;
        const jamb = Math.max(considerHiDPI(3), Math.min(considerHiDPI(7), scaleFactor*.6));
        ctxWrapper.save();
        ctx.strokeStyle = "rgba(0,0,0,.8)";
        ctx.lineWidth = considerHiDPI(5);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = considerHiDPI(2.5);
        ctx.setLineDash(state === "unknown" ? [considerHiDPI(4), considerHiDPI(3)] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        for (const p of [a, b]) {
            ctx.moveTo(p.x-nx*jamb, p.y-ny*jamb);
            ctx.lineTo(p.x+nx*jamb, p.y+ny*jamb);
        }
        ctx.stroke();
        if (state === "blocked") {
            const x = (a.x+b.x)/2, y = (a.y+b.y)/2, r = considerHiDPI(3);
            ctx.beginPath(); ctx.moveTo(x-r, y-r); ctx.lineTo(x+r, y+r);
            ctx.moveTo(x-r, y+r); ctx.lineTo(x+r, y-r); ctx.stroke();
        }
        ctxWrapper.restore();
    }

    tap(point: PointCoordinates, matrix: DOMMatrixInit): StructureInterceptionHandlerResult {
        const a = new DOMPoint(this.x0, this.y0).matrixTransform(matrix);
        const b = new DOMPoint(this.x1, this.y1).matrixTransform(matrix);
        const dx = b.x-a.x, dy = b.y-a.y, length2 = dx*dx+dy*dy;
        if (!length2) {
            return {stopPropagation: false};
        }
        const t = Math.max(0, Math.min(1, ((point.x-a.x)*dx+(point.y-a.y)*dy)/length2));
        if (Math.hypot(point.x-a.x-t*dx, point.y-a.y-t*dy) > considerHiDPI(9)) {
            return {stopPropagation: false};
        }
        const state = this.metadata.mapPassability ?? "unknown";
        const text = state === "clear" ? "The passage is clear in the map." :
            state === "blocked" ? "The passage is blocked in the map." : "Map clearance is unknown.";
        const saved = this.metadata.savedAt ? ` Map geometry saved: ${new Date(this.metadata.savedAt).toLocaleString()}.` : "";
        return {stopPropagation: true, openDialog: {title: "Doorway",
            body: `${text} Physical door position is not reported by this firmware.${saved}`}};
    }
}

export default DoorMapStructure;
