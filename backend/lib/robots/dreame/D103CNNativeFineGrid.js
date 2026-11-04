// D103CN ProbabilityGrid 1.4, from stock ProbabilityGrid::SerializeToBuffer
// and FetchGridmapROI. The packed file stores four bytes per 25 mm sample.
const MAX_CELLS = 2 * 1024 * 1024;
const OCCUPIED = 16384;
// Ordinary weak free reading found in both captured floors. Use zero history
// flags for a newly opened sample; subsequent lidar observations can update it.
const WEAK_FREE = 15974 * 65536;

function check(ok, message) {
    if (!ok) {
        throw new Error("Native probability grid: " + message);
    }
}

function shape(bounds) {
    const [x0,y0,x1,y1] = bounds;
    const width = x1-x0+1, height = y1-y0+1;
    check(bounds.length === 4 && bounds.every(v => Number.isInteger(v) && v >= 0 && v < 8192) &&
        width > 0 && height > 0 && width*height <= MAX_CELLS, "unsupported bounds");
    return {x0: x0,y0: y0,x1: x1,y1: y1,width: width,height: height};
}

function decode(data) {
    check(Buffer.isBuffer(data) && data.length >= 31 && data.length <= 8*1024*1024 &&
        data.readUInt16BE(0) === 0xaabb && data.readUInt16BE(data.length-2) === 0xeeff &&
        data.readUInt32BE(2)+8 === data.length && data.readUInt32BE(25)+31 === data.length &&
        data.readUInt16BE(6) === 0x0104 && data.readUInt16BE(8) === 25 && data.readUInt16BE(10) === 8192 &&
        data.readUInt16BE(12) === 8192 && data.readUInt16BE(14) === 4 && data[24] === 1, "unknown file format");
    const box = shape([16,18,20,22].map(i => data.readUInt16BE(i)));
    const raw = Buffer.alloc(box.width*box.height*4);
    let out = 0;
    for (let i=29; i<data.length-2; i++) {
        const value = data[i];
        if (value >= 128) {
            const n = value & 127;
            check(n > 0 && i+1 < data.length-2 && out+n <= raw.length, "invalid run");
            raw.fill(data[++i],out,out+n);
            out += n;
        } else {
            check(out < raw.length, "too many literal bytes");
            raw[out++] = value;
        }
    }
    check(out === raw.length, "truncated raster");
    return {...box,raw: raw};
}

function encode(grid, header) {
    const raw = grid.raw, out = Buffer.allocUnsafe(31+raw.length*2);
    header.copy(out,0,0,29);
    [grid.x0,grid.y0,grid.x1,grid.y1].forEach((v,i) => out.writeUInt16BE(v,16+i*2));
    let end = 29;
    for (let i=0; i<raw.length;) {
        const value = raw[i++];
        let n = 1;
        // Stock escapes each high byte separately, even if adjacent.
        while (value < 128 && n < 127 && i < raw.length && raw[i] === value) {
            i++; n++;
        }
        if (n > 1 || value >= 128) {
            out[end++] = 128 | n;
        }
        out[end++] = value;
    }
    check(end+2 <= 8*1024*1024, "edited file exceeds stock backup limit");
    out.writeUInt32BE(end-29,25);
    out.writeUInt32BE(end-6,2);
    out.writeUInt16BE(0xeeff,end);
    return out.subarray(0,end+2);
}

function bounds(g) {
    return [g.x0,g.y0,g.x1,g.y1];
}

function fit(grid, next) {
    const b = shape(next);
    if (b.x0 === grid.x0 && b.y0 === grid.y0 && b.x1 === grid.x1 && b.y1 === grid.y1) {
        return grid;
    }
    const raw = Buffer.alloc(b.width*b.height*4);
    const left = Math.max(b.x0,grid.x0), right = Math.min(b.x1,grid.x1);
    for (let y=Math.max(b.y0,grid.y0); y<=Math.min(b.y1,grid.y1); y++) {
        const src = ((y-grid.y0)*grid.width+left-grid.x0)*4;
        grid.raw.copy(raw,((y-b.y0)*b.width+left-b.x0)*4,src,src+4*(right-left+1));
    }
    return {...b,raw: raw};
}

function offset(g,x,y) {
    return x<g.x0 || x>g.x1 || y<g.y0 || y>g.y1 ? -1 : 4*((y-g.y0)*g.width+x-g.x0);
}

// The saved divider is centred on (1800,1800), the fine grid on (4096,4096).
// A divider pixel covers the samples immediately before and at its centre on
// each axis. SDK y increases downwards. Cross-checked on two physical floors.
function origin(x,y) {
    check(Number.isInteger(x) && Number.isInteger(y), "invalid cell coordinates");
    return [2*(x+1393)-1,2*(2703-y)-1];
}

function samples(g,x,y) {
    const [left,bottom] = origin(x,y);
    return [offset(g,left,bottom),offset(g,left+1,bottom),offset(g,left,bottom+1),offset(g,left+1,bottom+1)];
}

function read(g,i) {
    return i < 0 ? 0 : g.raw.readUInt32BE(i);
}

function opened(word) {
    const p = word >>> 16;
    check(p <= 32767, "unexpected probability marker");
    return p === 0 || p >= OCCUPIED ? WEAK_FREE : word;
}

function needsCheck(bytes) {
    const g = decode(bytes);
    return (x,y) => samples(g,x,y).some(i => (read(g,i) >>> 16) >= OCCUPIED);
}

function capture(bytes, edits) {
    const cells = edits.filter(e => e.reopen);
    if (!cells.length) {
        return;
    }
    const g = decode(bytes);
    cells[0].fineBounds = bounds(g);
    for (const e of cells) {
        e.fineBefore = samples(g,e.x,e.y).map(i => read(g,i));
    }
}

function expected(e) {
    check(Array.isArray(e.fineBefore) && e.fineBefore.length === 4 && e.fineBefore.every(
        w => Number.isSafeInteger(w) && w >= 0 && w <= 0x7fffffff), "missing original 25 mm samples");
    return e.fineBefore;
}

function matches(bytes, edits, restored) {
    const cells = edits.filter(e => e.reopen);
    if (!cells.length) {
        return true;
    }
    const g = decode(bytes);
    return cells.every(e => {
        const old = expected(e);
        return samples(g,e.x,e.y).every((i,k) => read(g,i) === (restored ? old[k] : opened(old[k])));
    });
}

function correct(bytes, edits, restoring = false) {
    const cells = edits.filter(e => e.reopen);
    if (!cells.length) {
        return bytes;
    }
    let g = decode(bytes);
    const oldBounds = cells[0].fineBounds;
    check(Array.isArray(oldBounds) && oldBounds.length === 4, "missing original extent");
    shape(oldBounds);
    const extent = oldBounds.slice();
    for (const {x,y} of cells) {
        const [left,bottom] = origin(x,y);
        extent[0]=Math.min(extent[0],left); extent[1]=Math.min(extent[1],bottom);
        extent[2]=Math.max(extent[2],left+1); extent[3]=Math.max(extent[3],bottom+1);
    }
    if (!restoring) {
        check(bounds(g).every((v,i) => oldBounds[i] === v), "grid bounds changed since editing");
        g = fit(g,extent);
    }
    let changed = false;
    for (const e of cells) {
        const old = expected(e);
        samples(g,e.x,e.y).forEach((i,k) => {
            const after = opened(old[k]);
            check(i >= 0 && read(g,i) === (restoring ? after : old[k]), "cell changed since editing; reload the map");
            if (after !== old[k]) {
                g.raw.writeUInt32BE(restoring ? old[k] : after,i);
                changed = true;
            }
        });
    }
    if (!changed) {
        return bytes;
    }
    if (restoring && extent.some((v,i) => v !== oldBounds[i]) && bounds(g).every((v,i) => v === extent[i])) {
        // Shrink back only if no other observations now occupy that margin.
        // Never crop another edit or inflate a rectangle the firmware shrank.
        const keep = oldBounds.slice();
        for (let y=g.y0; y<=g.y1; y++) {
            for (let x=g.x0; x<=g.x1; x++) {
                if ((x<keep[0] || y<keep[1] || x>keep[2] || y>keep[3]) && read(g,offset(g,x,y))) {
                    keep[0]=Math.min(keep[0],x); keep[1]=Math.min(keep[1],y);
                    keep[2]=Math.max(keep[2],x); keep[3]=Math.max(keep[3],y);
                }
            }
        }
        g = fit(g,keep);
    }
    return encode(g,bytes);
}

module.exports = {decode: decode,needsCheck: needsCheck,capture: capture,matches: matches,correct: correct};
